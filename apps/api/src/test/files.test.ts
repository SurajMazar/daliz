import type { FileRow, FileVersionRow, FolderContents, FolderRow, RoleRow, SignedUrl, StorageUsage, TenantUserRow } from '@daliz/shared';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PlatformDb } from '../database/platform/platform-db.js';
import { tenants } from '../database/platform/schema.js';
import { fileVersions } from '../database/tenant/schema.js';
import { TenantConnectionManager } from '../database/tenant/tenant-connection-manager.js';
import { StorageService } from '../infra/storage.js';
import { FilesService } from '../modules/files/files.service.js';
import { TenantDirectory } from '../modules/tenancy/tenant-directory.js';
import { TestEnv, type ApiClient, type TestTenant } from './harness.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n');
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe('files', () => {
  let t: TestEnv;
  let tenant: TestTenant;
  let manager: ApiClient;
  let managerEmail: string;
  let owner: ApiClient;

  /** Runs the malware scan the worker would run. */
  const scan = async (file: FileRow) => {
    const db = await t.get(TenantConnectionManager).get(tenant.tenantId);
    const versions = await db.select().from(fileVersions).where(eq(fileVersions.fileId, file.id));
    for (const v of versions) await t.get(FilesService).scanVersion(tenant.tenantId, v.id);
  };
  const upload = (client: ApiClient, buffer: Buffer, name: string, type: string, folderId?: string) => {
    const req = client.agent.post('/api/v1/files/upload').set('X-CSRF-Token', client.csrf!);
    if (client.host) req.set('Host', client.host);
    if (folderId) req.field('folderId', folderId);
    return req.attach('file', buffer, { filename: name, contentType: type });
  };

  beforeAll(async () => {
    t = await TestEnv.start();
    tenant = await t.createTenant();
    managerEmail = (await t.addUser(tenant.tenantId, 'manager')).email;
    manager = await t.loggedIn(managerEmail);
    owner = await t.loggedIn(tenant.ownerEmail);
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => t.clearRateLimits());

  it('uploads, scans, then serves files through short-lived signed URLs', async () => {
    const res = await upload(manager, PDF, 'Q3 board pack.pdf', 'application/pdf');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const file = res.body.data as FileRow;
    expect(file).toMatchObject({ name: 'Q3 board pack.pdf', extension: 'pdf', category: 'pdf', scanStatus: 'pending', previewable: true });

    // Not downloadable until the malware scan has passed.
    expect((await manager.get(`/files/${file.id}/download`)).code).toBe('CONFLICT');
    await scan(file);
    const signed = await manager.get<SignedUrl>(`/files/${file.id}/download`);
    expect(signed.status).toBe(200);
    const fetched = await fetch(signed.data.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(PDF)).toBe(true);
    // Tampering with the signature is refused by storage.
    expect((await fetch(signed.data.url.replace(/X-Amz-Signature=[0-9a-f]{4}/, 'X-Amz-Signature=0000'))).status).toBe(403);

    const preview = await manager.get<SignedUrl>(`/files/${file.id}/preview`);
    expect((await fetch(preview.data.url)).headers.get('content-disposition')).toMatch(/^inline;/);
  });

  it('rejects disallowed types and contents that don’t match the extension', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer();
    expect((await upload(manager, png, 'report.pdf', 'application/pdf')).status).toBe(415);
    expect((await upload(manager, Buffer.from('MZ\x90\x00binary'), 'setup.exe', 'application/octet-stream')).status).toBe(415);
    expect((await upload(manager, Buffer.from('<script>alert(1)</script>'), 'page.html', 'text/html')).status).toBe(415);
    expect((await upload(manager, Buffer.from([0x00, 0x01, 0x02, 0xff]), 'notes.txt', 'text/plain')).status).toBe(415);
    // Path components are stripped from client file names; names never become storage keys.
    const traversal = await upload(manager, Buffer.from('a,b\n1,2\n'), '../../etc/passwd.csv', 'text/csv');
    expect((traversal.body.data as FileRow).name).toBe('passwd.csv');
    expect((await upload(manager, Buffer.from('a,b\n1,2\n'), 'numbers.csv', 'text/csv')).status).toBe(201);
  });

  it('quarantines malware found by the scanner', async () => {
    const res = await upload(manager, Buffer.from(`Totally harmless\n${EICAR}\n`), 'readme.txt', 'text/plain');
    const file = res.body.data as FileRow;
    await scan(file);
    expect((await manager.get(`/files/${file.id}`)).status).toBe(404);
    const restore = await owner.post(`/files/${file.id}/restore`);
    expect(restore.status).toBe(403);
    expect((restore.body as { error: { message: string } }).error.message).toMatch(/quarantined/);
    const db = await t.get(TenantConnectionManager).get(tenant.tenantId);
    const [version] = await db.select().from(fileVersions).where(eq(fileVersions.fileId, file.id));
    expect(version!.scanStatus).toBe('infected');
    expect(await t.get(StorageService).getBuffer(version!.storageKey)).toBeNull();
    const audit = await owner.get<{ action: string }[]>('/audit?action=files.malware');
    expect(audit.data.length).toBe(1);
  });

  it('manages folders: nesting, unique names, moves, trash and restore', async () => {
    const reports = await manager.post<FolderRow>('/files/folders', { name: 'Reports' });
    expect(reports.status).toBe(201);
    expect((await manager.post('/files/folders', { name: 'reports' })).status).toBe(409);
    const y2026 = await manager.post<FolderRow>('/files/folders', { name: '2026', parentId: reports.data.id });
    const uploaded = await upload(manager, PDF, 'Budget.pdf', 'application/pdf', y2026.data.id);
    const file = uploaded.body.data as FileRow;
    expect(file.folderId).toBe(y2026.data.id);

    const contents = await manager.get<FolderContents>(`/files?folderId=${y2026.data.id}`);
    expect(contents.data.breadcrumbs.map((b) => b.name)).toEqual(['Reports', '2026']);
    expect(contents.data.files.map((f) => f.name)).toEqual(['Budget.pdf']);

    expect((await manager.patch(`/files/folders/${reports.data.id}`, { parentId: y2026.data.id, version: reports.data.version })).status).toBe(400);
    const renamed = await manager.patch<FileRow>(`/files/${file.id}`, { name: 'Budget 2026.pdf', version: file.version });
    expect(renamed.data.name).toBe('Budget 2026.pdf');
    expect((await manager.patch(`/files/${file.id}`, { name: 'Budget.exe', version: renamed.data.version })).status).toBe(400);

    // Managers can organise files but not delete them.
    expect((await manager.del(`/files/folders/${reports.data.id}`)).status).toBe(403);
    expect((await owner.del(`/files/folders/${reports.data.id}`)).status).toBe(200);
    expect((await manager.get(`/files/${file.id}`)).status).toBe(404);
    const trash = await owner.get<{ folders: FolderRow[]; files: FileRow[] }>('/files/trash');
    expect(trash.data.folders.map((f) => f.name)).toContain('Reports');
    expect(trash.data.files.map((f) => f.id)).not.toContain(file.id); // comes back with its folder

    expect((await owner.post(`/files/folders/${reports.data.id}/restore`)).status).toBe(200);
    expect((await manager.get<FileRow>(`/files/${file.id}`)).data.name).toBe('Budget 2026.pdf');
  });

  it('purges trashed items permanently, including stored objects', async () => {
    const res = await upload(manager, PDF, 'Old contract.pdf', 'application/pdf');
    const file = res.body.data as FileRow;
    const db = await t.get(TenantConnectionManager).get(tenant.tenantId);
    const [version] = await db.select().from(fileVersions).where(eq(fileVersions.fileId, file.id));
    expect((await owner.del(`/files/${file.id}/purge`)).status).toBe(409); // must be trashed first
    await owner.del(`/files/${file.id}`);
    expect((await owner.del(`/files/${file.id}/purge`)).status).toBe(200);
    expect(await t.get(StorageService).getBuffer(version!.storageKey)).toBeNull();
    expect((await owner.post(`/files/${file.id}/restore`)).status).toBe(404);
  });

  it('keeps versions and refuses a version of a different type', async () => {
    const first = (await upload(manager, Buffer.from('v1\n'), 'plan.md', 'text/markdown')).body.data as FileRow;
    const second = await manager.agent
      .post(`/api/v1/files/${first.id}/versions`)
      .set('X-CSRF-Token', manager.csrf!)
      .attach('file', Buffer.from('v2 with more detail\n'), { filename: 'plan.md', contentType: 'text/markdown' });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect((second.body.data as FileRow).versionCount).toBe(2);
    const versions = await manager.get<FileVersionRow[]>(`/files/${first.id}/versions`);
    expect(versions.data.map((v) => [v.versionNo, v.current])).toEqual([
      [2, true],
      [1, false],
    ]);
    const wrongType = await manager.agent
      .post(`/api/v1/files/${first.id}/versions`)
      .set('X-CSRF-Token', manager.csrf!)
      .attach('file', PDF, { filename: 'plan.pdf', contentType: 'application/pdf' });
    expect(wrongType.status).toBe(400);
  });

  it('keeps restricted folders private until shared, honouring view vs edit', async () => {
    const privateFolder = await manager.post<FolderRow>('/files/folders', { name: 'HR — confidential', visibility: 'restricted' });
    const inside = (await upload(manager, PDF, 'Salaries.pdf', 'application/pdf', privateFolder.data.id)).body.data as FileRow;
    await scan(inside);

    const colleague = await t.addUser(tenant.tenantId, 'employee');
    const other = await t.loggedIn(colleague.email);
    const root = await other.get<FolderContents>('/files');
    expect(root.data.folders.map((f) => f.name)).not.toContain('HR — confidential');
    expect((await other.get(`/files?folderId=${privateFolder.data.id}`)).status).toBe(404);
    expect((await other.get(`/files/${inside.id}`)).status).toBe(404);
    expect((await other.get(`/files/${inside.id}/download`)).status).toBe(404);
    const search = await other.get<FolderContents>('/files?q=salaries');
    expect(search.data.files).toHaveLength(0);

    // A colleague can't reshare what isn't theirs.
    expect((await other.post(`/files/folders/${privateFolder.data.id}/shares`, { principalType: 'user', principalId: colleague.userId, access: 'edit' })).status).toBe(404);

    const shares = await manager.post(`/files/folders/${privateFolder.data.id}/shares`, { principalType: 'user', principalId: colleague.userId, access: 'view' });
    expect(shares.status, JSON.stringify(shares.body)).toBe(201);
    expect((await other.get<FolderContents>('/files?q=salaries')).data.files.map((f) => f.name)).toEqual(['Salaries.pdf']);
    expect((await other.get<SignedUrl>(`/files/${inside.id}/download`)).status).toBe(200);
    expect((await upload(other, PDF, 'Mine.pdf', 'application/pdf', privateFolder.data.id)).status).toBe(403);

    // Sharing to a role grants edit to everyone holding it.
    const employeeRole = (await owner.get<RoleRow[]>('/roles')).data.find((r) => r.key === 'employee')!;
    await manager.post(`/files/folders/${privateFolder.data.id}/shares`, { principalType: 'role', principalId: employeeRole.id, access: 'edit' });
    expect((await upload(other, PDF, 'Mine.pdf', 'application/pdf', privateFolder.data.id)).status).toBe(201);
  });

  it('requires the right permission for each operation', async () => {
    const viewer = await t.loggedIn((await t.addUser(tenant.tenantId, 'viewer')).email);
    expect((await viewer.get<FolderContents>('/files')).status).toBe(200);
    expect((await upload(viewer, PDF, 'x.pdf', 'application/pdf')).status).toBe(403);
    expect((await viewer.post('/files/folders', { name: 'Nope' })).status).toBe(403);
    const accountant = await t.loggedIn((await t.addUser(tenant.tenantId, 'accountant')).email);
    const mine = (await upload(accountant, PDF, 'Receipt.pdf', 'application/pdf')).body.data as FileRow;
    expect((await accountant.del(`/files/${mine.id}`)).status).toBe(403); // accountants can't delete files
  });

  it('enforces the storage quota', async () => {
    const small = await t.createTenant();
    await t.get(PlatformDb).db.update(tenants).set({ storageQuotaMb: 1 }).where(eq(tenants.id, small.tenantId));
    await t.get(TenantDirectory).invalidate(small.tenantId);
    const smallOwner = await t.loggedIn(small.ownerEmail);
    const big = Buffer.alloc(1024 * 1024 + 10, 'a');
    const res = await upload(smallOwner, big, 'big.txt', 'text/plain');
    expect(res.body.error?.code).toBe('QUOTA_EXCEEDED');
    const usage = await smallOwner.get<StorageUsage>('/files/usage');
    expect(usage.data.quotaBytes).toBe(1024 * 1024);
  });

  it("never exposes one tenant's files to another", async () => {
    const mine = (await upload(manager, PDF, 'Secret.pdf', 'application/pdf')).body.data as FileRow;
    await scan(mine);
    const other = await t.createTenant();
    const stranger = await t.loggedIn(other.ownerEmail);
    expect((await stranger.get(`/files/${mine.id}`)).status).toBe(404);
    expect((await stranger.get(`/files/${mine.id}/download`)).status).toBe(404);
    expect((await stranger.del(`/files/${mine.id}`)).status).toBe(404);
    const list = await stranger.get<FolderContents>('/files?q=secret');
    expect(list.data.files).toHaveLength(0);
    // Sharing across tenants is impossible: the other tenant's user id doesn't exist here.
    const strangerMe = await stranger.me();
    const theirUser = (await stranger.get<TenantUserRow>(`/users/${strangerMe.data.tenant!.userId}`)).data;
    const share = await manager.post(`/files/${mine.id}/shares`, { principalType: 'user', principalId: theirUser.id, access: 'view' });
    expect(share.status).toBe(400);
  });
});
