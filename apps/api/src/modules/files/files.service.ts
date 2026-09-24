import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ALLOWED_FILE_TYPES,
  fileNameSchema,
  fileTypeForName,
  type AllowedFileType,
  type FileRow,
  type FileShareRow,
  type FileVersionRow,
  type FolderContents,
  type FolderRow,
  type Person,
  type ShareTargets,
  type SignedUrl,
  type StorageUsage,
} from '@daliz/shared';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import { ENV, type Env } from '../../config/env.js';
import { sha256Hex } from '../../common/crypto.js';
import { Errors } from '../../common/errors.js';
import { qcol } from '../../common/sql.js';
import { RequestContext, type TenantContext } from '../../common/request-context.js';
import { fileShares, fileVersions, files, folders, roles, userRoles, users } from '../../database/tenant/schema.js';
import { TenantConnectionManager } from '../../database/tenant/tenant-connection-manager.js';
import type { TenantDb } from '../../database/tenant/tenant-db.js';
import { MalwareScanService } from '../../infra/malware.js';
import { QueueService } from '../../infra/queue.js';
import { StorageService } from '../../infra/storage.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantDirectory } from '../tenancy/tenant-directory.js';

type Access = 'none' | 'view' | 'edit';
const rank: Record<Access, number> = { none: 0, view: 1, edit: 2 };
const min = (a: Access, b: Access): Access => (rank[a] <= rank[b] ? a : b);
const max = (a: Access, b: Access): Access => (rank[a] >= rank[b] ? a : b);

interface FolderNode {
  id: string;
  parentId: string | null;
  name: string;
  visibility: 'workspace' | 'restricted';
  createdBy: string | null;
  deletedAt: Date | null;
}

/** Per-request view of what the caller can reach in the library. */
class AccessIndex {
  constructor(
    readonly folders: Map<string, FolderNode>,
    private readonly folderShares: Map<string, Access>,
    private readonly fileShares: Map<string, Access>,
    private readonly userId: string | null,
    private readonly isManager: boolean,
  ) {}

  private ancestors(folderId: string): FolderNode[] {
    const chain: FolderNode[] = [];
    const seen = new Set<string>();
    for (let f = this.folders.get(folderId); f && !seen.has(f.id); f = f.parentId ? this.folders.get(f.parentId) : undefined) {
      seen.add(f.id);
      chain.push(f);
    }
    return chain;
  }

  /** Shares inherit downward: a share on a folder covers everything beneath it. */
  private shareOnOrAbove(chainFromHere: FolderNode[]): Access {
    return chainFromHere.reduce<Access>((acc, f) => max(acc, this.folderShares.get(f.id) ?? 'none'), 'none');
  }

  folder(folderId: string | null): Access {
    if (folderId === null) return 'edit';
    if (!this.folders.has(folderId)) return 'none';
    if (this.isManager) return 'edit';
    const chain = this.ancestors(folderId);
    let access: Access = 'edit';
    chain.forEach((f, i) => {
      if (f.visibility !== 'restricted') return;
      const granted = f.createdBy !== null && f.createdBy === this.userId ? 'edit' : this.shareOnOrAbove(chain.slice(i));
      access = min(access, granted);
    });
    return access;
  }

  file(file: { id: string; folderId: string | null }): Access {
    return max(this.folder(file.folderId), this.isManager ? 'edit' : (this.fileShares.get(file.id) ?? 'none'));
  }

  restricted(folderId: string | null): boolean {
    return folderId !== null && this.ancestors(folderId).some((f) => f.visibility === 'restricted');
  }

  sharedFileIds(): string[] {
    return [...this.fileShares.keys()];
  }
}

const FILE_KEY_PREFIX = 'files';

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly maxBytes: number;

  constructor(
    @Inject(ENV) env: Env,
    private readonly storage: StorageService,
    private readonly scanner: MalwareScanService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly directory: TenantDirectory,
    private readonly connections: TenantConnectionManager,
  ) {
    this.maxBytes = env.FILE_MAX_UPLOAD_MB * 1024 * 1024;
  }

  get maxUploadBytes(): number {
    return this.maxBytes;
  }

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  private async accessIndex(ctx: TenantContext): Promise<AccessIndex> {
    const { db } = ctx;
    const allFolders = await db
      .select({ id: folders.id, parentId: folders.parentId, name: folders.name, visibility: folders.visibility, createdBy: folders.createdBy, deletedAt: folders.deletedAt })
      .from(folders);
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const roleIds = userId ? (await db.select({ id: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId))).map((r) => r.id) : [];
    const principals = [...(userId ? [userId] : []), ...roleIds];
    const shares = principals.length
      ? await db.select().from(fileShares).where(inArray(fileShares.principalId, principals))
      : [];
    const folderShareMap = new Map<string, Access>();
    const fileShareMap = new Map<string, Access>();
    for (const s of shares) {
      const target = s.folderId ? folderShareMap : fileShareMap;
      const key = (s.folderId ?? s.fileId)!;
      target.set(key, max(target.get(key) ?? 'none', s.access));
    }
    return new AccessIndex(new Map(allFolders.map((f) => [f.id, f])), folderShareMap, fileShareMap, userId, ctx.permissions.has('files.share'));
  }

  private assertAccess(access: Access, needed: 'view' | 'edit'): void {
    if (access === 'none') throw Errors.notFound();
    if (needed === 'edit' && access !== 'edit') throw Errors.forbidden('You have view-only access here.');
  }

  private async liveFolder(db: TenantDb, id: string) {
    const [folder] = await db.select().from(folders).where(and(eq(folders.id, id), isNull(folders.deletedAt)));
    if (!folder) throw Errors.notFound();
    return folder;
  }

  private async liveFile(db: TenantDb, id: string, includeDeleted = false) {
    const [file] = await db.select().from(files).where(and(eq(files.id, id), includeDeleted ? undefined : isNull(files.deletedAt)));
    if (!file) throw Errors.notFound();
    return file;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  private async people(db: TenantDb, ids: (string | null)[]): Promise<Map<string, Person>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map();
    const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
    return new Map(rows.map((r) => [r.id, r]));
  }

  private folderRow(f: typeof folders.$inferSelect, idx: AccessIndex, people: Map<string, Person>): FolderRow {
    return {
      id: f.id,
      parentId: f.parentId,
      name: f.name,
      visibility: f.visibility,
      restricted: idx.restricted(f.id),
      canEdit: idx.folder(f.id) === 'edit',
      createdBy: f.createdBy ? (people.get(f.createdBy) ?? null) : null,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
      deletedAt: f.deletedAt?.toISOString() ?? null,
      version: f.version,
    };
  }

  private async fileRows(db: TenantDb, rows: (typeof files.$inferSelect)[], idx: AccessIndex): Promise<FileRow[]> {
    if (!rows.length) return [];
    const versionIds = rows.map((r) => r.currentVersionId).filter((x): x is string => !!x);
    const versions = versionIds.length ? await db.select({ id: fileVersions.id, scanStatus: fileVersions.scanStatus }).from(fileVersions).where(inArray(fileVersions.id, versionIds)) : [];
    const scan = new Map(versions.map((v) => [v.id, v.scanStatus]));
    const people = await this.people(db, rows.map((r) => r.createdBy));
    return rows.map((f) => {
      const type = fileTypeForName(`x.${f.extension}`);
      return {
        id: f.id,
        folderId: f.folderId,
        name: f.name,
        extension: f.extension,
        mimeType: f.mimeType,
        category: type?.category ?? 'document',
        sizeBytes: f.sizeBytes,
        previewable: type?.previewable ?? false,
        versionCount: f.versionCount,
        scanStatus: scan.get(f.currentVersionId ?? '') ?? 'pending',
        description: f.description,
        canEdit: idx.file(f) === 'edit',
        createdBy: f.createdBy ? (people.get(f.createdBy) ?? null) : null,
        createdAt: f.createdAt.toISOString(),
        updatedAt: f.updatedAt.toISOString(),
        deletedAt: f.deletedAt?.toISOString() ?? null,
        version: f.version,
      };
    });
  }

  /**
   * Folder contents, or a library-wide search when `q`/`category` is given without a folder.
   * Only folders and files the caller can access are returned.
   */
  async contents(q: { folderId?: string; q?: string; category?: string; sort: 'name' | 'size' | 'updated'; order: 'asc' | 'desc'; page: number; pageSize: number }): Promise<FolderContents> {
    const ctx = RequestContext.tenant();
    const { db } = ctx;
    const idx = await this.accessIndex(ctx);
    const searching = !q.folderId && (!!q.q || !!q.category);
    let folder: typeof folders.$inferSelect | null = null;
    if (q.folderId) {
      folder = await this.liveFolder(db, q.folderId);
      this.assertAccess(idx.folder(folder.id), 'view');
    }

    const breadcrumbs: { id: string; name: string }[] = [];
    for (let f = folder ? idx.folders.get(folder.id) : undefined; f; f = f.parentId ? idx.folders.get(f.parentId) : undefined) {
      breadcrumbs.unshift({ id: f.id, name: f.name });
    }

    const childFolders = searching
      ? []
      : (
          await db
            .select()
            .from(folders)
            .where(and(q.folderId ? eq(folders.parentId, q.folderId) : isNull(folders.parentId), isNull(folders.deletedAt)))
            .orderBy(asc(sql`lower(${folders.name})`))
        ).filter((f) => idx.folder(f.id) !== 'none');

    const category = q.category ? ALLOWED_FILE_TYPES.filter((t) => t.category === q.category).map((t) => t.ext) : null;
    const scope: SQL | undefined = searching
      ? (() => {
          const reachable = [...idx.folders.values()].filter((f) => !f.deletedAt && idx.folder(f.id) !== 'none').map((f) => f.id);
          const shared = idx.sharedFileIds();
          return or(isNull(files.folderId), reachable.length ? inArray(files.folderId, reachable) : undefined, shared.length ? inArray(files.id, shared) : undefined);
        })()
      : q.folderId
        ? eq(files.folderId, q.folderId)
        : isNull(files.folderId);
    const where = and(
      isNull(files.deletedAt),
      scope,
      q.q ? sql`lower(${files.name}) like ${`%${q.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`}` : undefined,
      category ? inArray(files.extension, category.length ? category : ['__none__']) : undefined,
    );
    const orderCol = q.sort === 'size' ? files.sizeBytes : q.sort === 'updated' ? files.updatedAt : sql`lower(${files.name})`;
    const [total] = await db.select({ n: count() }).from(files).where(where);
    const rows = await db
      .select()
      .from(files)
      .where(where)
      .orderBy(q.order === 'desc' ? desc(orderCol) : asc(orderCol))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const people = await this.people(db, [folder?.createdBy ?? null, ...childFolders.map((f) => f.createdBy)]);
    return {
      folder: folder ? this.folderRow(folder, idx, people) : null,
      breadcrumbs,
      folders: childFolders.map((f) => this.folderRow(f, idx, people)),
      files: await this.fileRows(db, rows, idx),
      meta: { page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) },
    };
  }

  async getFile(id: string): Promise<FileRow> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    const file = await this.liveFile(ctx.db, id);
    this.assertAccess(idx.file(file), 'view');
    return (await this.fileRows(ctx.db, [file], idx))[0]!;
  }

  async versions(id: string): Promise<FileVersionRow[]> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    const file = await this.liveFile(ctx.db, id);
    this.assertAccess(idx.file(file), 'view');
    const rows = await ctx.db.select().from(fileVersions).where(eq(fileVersions.fileId, id)).orderBy(desc(fileVersions.versionNo));
    const people = await this.people(ctx.db, rows.map((r) => r.uploadedBy));
    return rows.map((v) => ({
      id: v.id,
      versionNo: v.versionNo,
      sizeBytes: v.sizeBytes,
      sha256: v.sha256,
      originalName: v.originalName,
      scanStatus: v.scanStatus,
      uploadedBy: v.uploadedBy ? (people.get(v.uploadedBy) ?? null) : null,
      createdAt: v.createdAt.toISOString(),
      current: v.id === file.currentVersionId,
    }));
  }

  async usage(): Promise<StorageUsage> {
    const ctx = RequestContext.tenant();
    const tenant = (await this.directory.get(ctx.tenantId))!;
    const [all] = await ctx.db.select({ bytes: sql<string>`coalesce(sum(${fileVersions.sizeBytes}), 0)::text` }).from(fileVersions).where(sql`${fileVersions.scanStatus} <> 'infected'`);
    const [trash] = await ctx.db
      .select({ bytes: sql<string>`coalesce(sum(${fileVersions.sizeBytes}), 0)::text` })
      .from(fileVersions)
      .innerJoin(files, eq(files.id, fileVersions.fileId))
      .where(isNotNull(files.deletedAt));
    const [n] = await ctx.db.select({ n: count() }).from(files).where(isNull(files.deletedAt));
    return { usedBytes: Number(all?.bytes ?? 0), quotaBytes: tenant.storageQuotaMb * 1024 * 1024, fileCount: Number(n?.n ?? 0), trashBytes: Number(trash?.bytes ?? 0) };
  }

  // -------------------------------------------------------------------------
  // Folders
  // -------------------------------------------------------------------------

  async createFolder(input: { name: string; parentId: string | null; visibility: 'workspace' | 'restricted' }): Promise<FolderRow> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    if (input.parentId) {
      await this.liveFolder(ctx.db, input.parentId);
      this.assertAccess(idx.folder(input.parentId), 'edit');
    }
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const [row] = await ctx.db
      .insert(folders)
      .values({ name: input.name, parentId: input.parentId, visibility: input.visibility, createdBy: userId })
      .onConflictDoNothing()
      .returning();
    if (!row) throw Errors.conflict(`A folder named “${input.name}” already exists here.`);
    await this.audit.tenantEvent({ action: 'files.folder_created', resourceType: 'folder', resourceId: row.id, metadata: { name: input.name, parentId: input.parentId, visibility: input.visibility } });
    const fresh = await this.accessIndex(ctx);
    return this.folderRow(row, fresh, await this.people(ctx.db, [row.createdBy]));
  }

  async updateFolder(id: string, patch: { name?: string; parentId?: string | null; visibility?: 'workspace' | 'restricted'; version: number }): Promise<FolderRow> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    const folder = await this.liveFolder(ctx.db, id);
    this.assertAccess(idx.folder(id), 'edit');
    if (patch.visibility && patch.visibility !== folder.visibility) {
      const isCreator = ctx.actor.type === 'user' && folder.createdBy === ctx.actor.userId;
      if (!isCreator && !ctx.permissions.has('files.share')) throw Errors.forbidden('Only the folder’s creator or a file manager can change who sees it.');
    }
    if (patch.parentId !== undefined && patch.parentId !== folder.parentId) {
      if (patch.parentId) {
        await this.liveFolder(ctx.db, patch.parentId);
        this.assertAccess(idx.folder(patch.parentId), 'edit');
        // Refuse to move a folder into itself or its own subtree.
        for (let f = idx.folders.get(patch.parentId); f; f = f.parentId ? idx.folders.get(f.parentId) : undefined) {
          if (f.id === id) throw Errors.badRequest('A folder can’t be moved into itself.');
        }
      }
    }
    const { version, ...fields } = patch;
    let updated;
    try {
      updated = await ctx.db
        .update(folders)
        .set({ ...fields, version: folder.version + 1, updatedAt: new Date() })
        .where(and(eq(folders.id, id), eq(folders.version, version)))
        .returning();
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code === '23505' || (err as { code?: string }).code === '23505') {
        throw Errors.conflict('A folder with that name already exists there.');
      }
      throw err;
    }
    if (!updated.length) throw Errors.versionConflict();
    await this.audit.tenantEvent({ action: 'files.folder_updated', resourceType: 'folder', resourceId: id, metadata: fields });
    return this.folderRow(updated[0]!, await this.accessIndex(ctx), await this.people(ctx.db, [updated[0]!.createdBy]));
  }

  private subtree(idx: AccessIndex, rootId: string): string[] {
    const out = [rootId];
    for (let i = 0; i < out.length; i++) {
      for (const f of idx.folders.values()) if (f.parentId === out[i]) out.push(f.id);
    }
    return out;
  }

  async trashFolder(id: string): Promise<void> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    await this.liveFolder(ctx.db, id);
    this.assertAccess(idx.folder(id), 'edit');
    const ids = this.subtree(idx, id);
    const now = new Date();
    const by = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    await ctx.db.transaction(async (tx) => {
      await tx.update(folders).set({ deletedAt: now, deletedBy: by }).where(and(inArray(folders.id, ids), isNull(folders.deletedAt)));
      await tx.update(files).set({ deletedAt: now, deletedBy: by }).where(and(inArray(files.folderId, ids), isNull(files.deletedAt)));
    });
    await this.audit.tenantEvent({ action: 'files.folder_trashed', resourceType: 'folder', resourceId: id, metadata: { folders: ids.length } });
  }

  // -------------------------------------------------------------------------
  // Upload & versions
  // -------------------------------------------------------------------------

  /** Validates bytes against the allow-list. The extension picks the type; the signature must agree. */
  async validateUpload(buffer: Buffer, originalName: string): Promise<{ type: AllowedFileType; name: string }> {
    if (buffer.length === 0) throw Errors.badRequest('The file is empty.');
    if (buffer.length > this.maxBytes) throw Errors.payloadTooLarge(`Files can be at most ${Math.round(this.maxBytes / 1024 / 1024)} MB.`);
    const parsedName = fileNameSchema.safeParse(originalName);
    if (!parsedName.success) throw Errors.badRequest('The file name isn’t valid.');
    const type = fileTypeForName(parsedName.data);
    if (!type) throw Errors.unsupportedMedia('This file type isn’t allowed. Upload documents, spreadsheets, PDFs, images, text, archives or media.');
    const detected = await fileTypeFromBuffer(buffer);
    if (type.signatures === 'text') {
      const head = buffer.subarray(0, 1024 * 1024);
      if (detected || head.includes(0)) throw Errors.unsupportedMedia('The file contents don’t match its type.');
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - (head.length === 1024 * 1024 ? 4 : 0)));
      } catch {
        throw Errors.unsupportedMedia('Text files must be UTF-8 encoded.');
      }
    } else if (!detected || !type.signatures.includes(detected.ext)) {
      throw Errors.unsupportedMedia('The file contents don’t match its type.');
    }
    return { type, name: parsedName.data };
  }

  private async assertQuota(ctx: TenantContext, extraBytes: number): Promise<void> {
    const usage = await this.usage();
    if (usage.usedBytes + extraBytes > usage.quotaBytes) {
      throw Errors.quotaExceeded('This workspace is out of storage. Empty the trash or ask your provider for more space.');
    }
    void ctx;
  }

  async upload(buffer: Buffer, originalName: string, opts: { folderId: string | null; fileId?: string }): Promise<FileRow> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    const { type, name } = await this.validateUpload(buffer, originalName);
    await this.assertQuota(ctx, buffer.length);
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const sha256 = sha256Hex(buffer);

    let fileId = opts.fileId;
    let versionNo = 1;
    if (fileId) {
      const existing = await this.liveFile(ctx.db, fileId);
      this.assertAccess(idx.file(existing), 'edit');
      if (existing.extension !== type.ext && fileTypeForName(`x.${existing.extension}`)?.mime !== type.mime) {
        throw Errors.badRequest(`A new version must be the same type (.${existing.extension}).`);
      }
      versionNo = existing.versionCount + 1;
    } else {
      if (opts.folderId) {
        await this.liveFolder(ctx.db, opts.folderId);
        this.assertAccess(idx.folder(opts.folderId), 'edit');
      }
      fileId = randomUUID();
    }
    const versionId = randomUUID();
    const key = StorageService.tenantKey(ctx.tenantId, FILE_KEY_PREFIX, fileId, versionId);
    await this.storage.put(key, buffer, type.mime);

    try {
      await ctx.db.transaction(async (tx) => {
        if (versionNo === 1) {
          await tx.insert(files).values({
            id: fileId!,
            folderId: opts.folderId,
            name,
            extension: type.ext,
            mimeType: type.mime,
            sizeBytes: buffer.length,
            createdBy: userId,
          });
        }
        await tx.insert(fileVersions).values({ id: versionId, fileId: fileId!, versionNo, storageKey: key, sizeBytes: buffer.length, sha256, mimeType: type.mime, originalName: name, uploadedBy: userId });
        const updated = await tx
          .update(files)
          .set({ currentVersionId: versionId, versionCount: versionNo, sizeBytes: buffer.length, updatedAt: new Date(), ...(versionNo > 1 ? { version: sql`${files.version} + 1` } : {}) })
          .where(and(eq(files.id, fileId!), eq(files.versionCount, versionNo - 1 || 1)))
          .returning({ id: files.id });
        if (versionNo > 1 && !updated.length) throw Errors.conflict('Someone uploaded another version at the same time. Try again.');
      });
    } catch (err) {
      await this.storage.delete([key]).catch(() => undefined);
      throw err;
    }
    await this.queue.enqueueFileScan({ tenantId: ctx.tenantId, fileVersionId: versionId });
    await this.audit.tenantEvent({
      action: versionNo === 1 ? 'files.uploaded' : 'files.version_uploaded',
      resourceType: 'file',
      resourceId: fileId,
      metadata: { name, bytes: buffer.length, sha256, version: versionNo, folderId: opts.folderId },
    });
    return this.getFile(fileId);
  }

  /** Scans one stored version. Runs in the worker with an explicit tenant id. */
  async scanVersion(tenantId: string, versionId: string): Promise<'clean' | 'infected' | 'missing'> {
    const db = await this.connections.get(tenantId);
    const [version] = await db.select().from(fileVersions).where(eq(fileVersions.id, versionId));
    if (!version) return 'missing';
    if (version.scanStatus === 'clean' || version.scanStatus === 'infected') return version.scanStatus;
    const data = await this.storage.getBuffer(version.storageKey);
    if (!data) {
      await db.update(fileVersions).set({ scanStatus: 'error', scanDetail: 'Object missing', scannedAt: new Date() }).where(eq(fileVersions.id, versionId));
      return 'missing';
    }
    const result = await this.scanner.scan(data);
    if (result.clean) {
      await db.update(fileVersions).set({ scanStatus: 'clean', scanDetail: result.engine, scannedAt: new Date() }).where(eq(fileVersions.id, versionId));
      return 'clean';
    }
    await this.storage.delete([version.storageKey]);
    await db.transaction(async (tx) => {
      await tx.update(fileVersions).set({ scanStatus: 'infected', scanDetail: `${result.engine}: ${result.signature}`, scannedAt: new Date() }).where(eq(fileVersions.id, versionId));
      await tx.update(files).set({ deletedAt: new Date() }).where(and(eq(files.id, version.fileId), eq(files.currentVersionId, versionId)));
    });
    await this.audit.tenantSystemEvent(db, {
      action: 'files.malware_detected',
      outcome: 'failure',
      resourceType: 'file',
      resourceId: version.fileId,
      metadata: { versionId, signature: result.signature, engine: result.engine, name: version.originalName },
    });
    await this.audit.securityEvent({ type: 'files.malware_detected', severity: 'critical', tenantId, metadata: { fileId: version.fileId, signature: result.signature } });
    this.logger.warn({ tenantId, versionId, signature: result.signature }, 'malware quarantined');
    return 'infected';
  }

  private async cleanVersion(db: TenantDb, file: typeof files.$inferSelect, versionId?: string) {
    const id = versionId ?? file.currentVersionId;
    const [version] = await db.select().from(fileVersions).where(and(eq(fileVersions.id, id ?? ''), eq(fileVersions.fileId, file.id)));
    if (!version) throw Errors.notFound();
    if (version.scanStatus === 'pending') throw Errors.conflict('This file is still being scanned for malware. Try again in a moment.');
    if (version.scanStatus !== 'clean') throw Errors.forbidden('This file failed the malware scan and can’t be downloaded.');
    return version;
  }

  async downloadUrl(id: string, versionId?: string): Promise<SignedUrl> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    const file = await this.liveFile(ctx.db, id);
    this.assertAccess(idx.file(file), 'view');
    const version = await this.cleanVersion(ctx.db, file, versionId);
    const url = await this.storage.signedDownloadUrl(version.storageKey, file.name, { expiresInSeconds: 120, contentType: version.mimeType });
    await this.audit.tenantEvent({ action: 'files.downloaded', resourceType: 'file', resourceId: id, metadata: { versionId: version.id, name: file.name } });
    return { url, expiresAt: new Date(Date.now() + 120_000).toISOString() };
  }

  async previewUrl(id: string): Promise<SignedUrl> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    const file = await this.liveFile(ctx.db, id);
    this.assertAccess(idx.file(file), 'view');
    const type = fileTypeForName(`x.${file.extension}`);
    if (!type?.previewable) throw Errors.badRequest('This file type can’t be previewed. Download it instead.');
    const version = await this.cleanVersion(ctx.db, file);
    const url = await this.storage.signedDownloadUrl(version.storageKey, file.name, { expiresInSeconds: 300, inline: true, contentType: type.mime });
    return { url, expiresAt: new Date(Date.now() + 300_000).toISOString() };
  }

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------

  async updateFile(id: string, patch: { name?: string; folderId?: string | null; description?: string; version: number }): Promise<FileRow> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    const file = await this.liveFile(ctx.db, id);
    this.assertAccess(idx.file(file), 'edit');
    if (patch.name) {
      const type = fileTypeForName(patch.name);
      if (!type || fileTypeForName(`x.${file.extension}`)?.mime !== type.mime) throw Errors.badRequest(`Keep the .${file.extension} extension when renaming.`);
    }
    if (patch.folderId !== undefined && patch.folderId !== file.folderId && patch.folderId !== null) {
      await this.liveFolder(ctx.db, patch.folderId);
      this.assertAccess(idx.folder(patch.folderId), 'edit');
    }
    const { version, ...fields } = patch;
    const updated = await ctx.db
      .update(files)
      .set({ ...fields, version: file.version + 1, updatedAt: new Date() })
      .where(and(eq(files.id, id), eq(files.version, version)))
      .returning({ id: files.id });
    if (!updated.length) throw Errors.versionConflict();
    await this.audit.tenantEvent({ action: patch.folderId !== undefined ? 'files.moved' : 'files.updated', resourceType: 'file', resourceId: id, metadata: fields });
    return this.getFile(id);
  }

  async copyFile(id: string, dest: { folderId: string | null; name?: string }): Promise<FileRow> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    const file = await this.liveFile(ctx.db, id);
    this.assertAccess(idx.file(file), 'view');
    if (dest.folderId) {
      await this.liveFolder(ctx.db, dest.folderId);
      this.assertAccess(idx.folder(dest.folderId), 'edit');
    }
    const version = await this.cleanVersion(ctx.db, file);
    await this.assertQuota(ctx, version.sizeBytes);
    const newId = randomUUID();
    const newVersionId = randomUUID();
    const key = StorageService.tenantKey(ctx.tenantId, FILE_KEY_PREFIX, newId, newVersionId);
    await this.storage.copy(version.storageKey, key);
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const name = dest.name ?? `Copy of ${file.name}`.slice(0, 200);
    await ctx.db.transaction(async (tx) => {
      await tx.insert(files).values({ id: newId, folderId: dest.folderId, name, extension: file.extension, mimeType: file.mimeType, sizeBytes: version.sizeBytes, currentVersionId: newVersionId, createdBy: userId, description: file.description });
      await tx.insert(fileVersions).values({
        id: newVersionId,
        fileId: newId,
        versionNo: 1,
        storageKey: key,
        sizeBytes: version.sizeBytes,
        sha256: version.sha256,
        mimeType: version.mimeType,
        originalName: name,
        scanStatus: 'clean',
        scanDetail: `copied from ${version.id}`,
        scannedAt: new Date(),
        uploadedBy: userId,
      });
    });
    await this.audit.tenantEvent({ action: 'files.copied', resourceType: 'file', resourceId: newId, metadata: { from: id, folderId: dest.folderId } });
    return this.getFile(newId);
  }

  async trashFile(id: string): Promise<void> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    const file = await this.liveFile(ctx.db, id);
    this.assertAccess(idx.file(file), 'edit');
    await ctx.db.update(files).set({ deletedAt: new Date(), deletedBy: ctx.actor.type === 'user' ? ctx.actor.userId : null }).where(eq(files.id, id));
    await this.audit.tenantEvent({ action: 'files.trashed', resourceType: 'file', resourceId: id, metadata: { name: file.name } });
  }

  async trash(): Promise<{ folders: FolderRow[]; files: FileRow[] }> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const mineOnly = !ctx.permissions.has('files.share');
    const trashedFolders = await ctx.db
      .select()
      .from(folders)
      .where(and(isNotNull(folders.deletedAt), mineOnly && userId ? eq(folders.deletedBy, userId) : undefined))
      .orderBy(desc(folders.deletedAt))
      .limit(500);
    // Only top-level trashed folders (their contents come back with them).
    const topFolders = trashedFolders.filter((f) => !f.parentId || !idx.folders.get(f.parentId)?.deletedAt || idx.folders.get(f.parentId)?.deletedAt?.getTime() !== f.deletedAt?.getTime());
    const trashedFiles = await ctx.db
      .select()
      .from(files)
      .where(and(isNotNull(files.deletedAt), mineOnly && userId ? eq(files.deletedBy, userId) : undefined))
      .orderBy(desc(files.deletedAt))
      .limit(500);
    const looseFiles = trashedFiles.filter((f) => !f.folderId || !idx.folders.get(f.folderId)?.deletedAt || idx.folders.get(f.folderId)?.deletedAt?.getTime() !== f.deletedAt?.getTime());
    const people = await this.people(ctx.db, topFolders.map((f) => f.createdBy));
    return {
      folders: topFolders.map((f) => this.folderRow(f, idx, people)),
      files: await this.fileRows(ctx.db, looseFiles, idx),
    };
  }

  async restore(kind: 'file' | 'folder', id: string): Promise<void> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    if (kind === 'file') {
      const file = await this.liveFile(ctx.db, id, true);
      if (!file.deletedAt) return;
      const [infected] = await ctx.db.select({ id: fileVersions.id }).from(fileVersions).where(and(eq(fileVersions.id, file.currentVersionId ?? ''), eq(fileVersions.scanStatus, 'infected')));
      if (infected) throw Errors.forbidden('Files quarantined by the malware scanner can’t be restored.');
      const parentGone = file.folderId ? !!idx.folders.get(file.folderId)?.deletedAt : false;
      const folderId = parentGone ? null : file.folderId;
      this.assertAccess(idx.folder(folderId), 'edit');
      await ctx.db.update(files).set({ deletedAt: null, deletedBy: null, folderId, updatedAt: new Date() }).where(eq(files.id, id));
    } else {
      const [folder] = await ctx.db.select().from(folders).where(eq(folders.id, id));
      if (!folder?.deletedAt) throw Errors.notFound();
      const parentGone = folder.parentId ? !!idx.folders.get(folder.parentId)?.deletedAt : false;
      const ids = this.subtree(idx, id);
      await ctx.db.transaction(async (tx) => {
        await tx
          .update(folders)
          .set({ deletedAt: null, deletedBy: null, ...(parentGone ? { parentId: null } : {}) })
          .where(and(eq(folders.id, id)));
        await tx.update(folders).set({ deletedAt: null, deletedBy: null }).where(and(inArray(folders.id, ids), eq(folders.deletedAt, folder.deletedAt!)));
        await tx.update(files).set({ deletedAt: null, deletedBy: null }).where(and(inArray(files.folderId, ids), eq(files.deletedAt, folder.deletedAt!)));
      });
    }
    await this.audit.tenantEvent({ action: `files.${kind}_restored`, resourceType: kind, resourceId: id });
  }

  /** Permanently deletes a trashed file or folder, including stored objects. */
  async purge(kind: 'file' | 'folder', id: string): Promise<void> {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    let fileIds: string[];
    let folderIds: string[] = [];
    if (kind === 'file') {
      const file = await this.liveFile(ctx.db, id, true);
      if (!file.deletedAt) throw Errors.conflict('Move the file to the trash first.');
      fileIds = [id];
    } else {
      const [folder] = await ctx.db.select().from(folders).where(eq(folders.id, id));
      if (!folder?.deletedAt) throw Errors.conflict('Move the folder to the trash first.');
      folderIds = this.subtree(idx, id);
      fileIds = (await ctx.db.select({ id: files.id }).from(files).where(inArray(files.folderId, folderIds))).map((f) => f.id);
    }
    const keys = fileIds.length ? (await ctx.db.select({ key: fileVersions.storageKey }).from(fileVersions).where(inArray(fileVersions.fileId, fileIds))).map((v) => v.key) : [];
    await ctx.db.transaction(async (tx) => {
      if (fileIds.length) await tx.delete(files).where(inArray(files.id, fileIds));
      for (const fid of [...folderIds].reverse()) await tx.delete(folders).where(eq(folders.id, fid));
    });
    for (let i = 0; i < keys.length; i += 500) await this.storage.delete(keys.slice(i, i + 500)).catch(() => undefined);
    await this.audit.tenantEvent({ action: `files.${kind}_purged`, resourceType: kind, resourceId: id, metadata: { files: fileIds.length, objects: keys.length } });
  }

  /** Maintenance: permanently remove items that have been in the trash past retention. */
  async purgeExpiredTrash(tenantId: string, db: TenantDb, olderThan: Date): Promise<number> {
    const stale = await db.select({ id: files.id }).from(files).where(and(isNotNull(files.deletedAt), lt(files.deletedAt, olderThan)));
    if (!stale.length) return 0;
    const ids = stale.map((s) => s.id);
    const keys = (await db.select({ key: fileVersions.storageKey }).from(fileVersions).where(inArray(fileVersions.fileId, ids))).map((v) => v.key);
    await db.delete(files).where(inArray(files.id, ids));
    for (let i = 0; i < keys.length; i += 500) await this.storage.delete(keys.slice(i, i + 500)).catch(() => undefined);
    await db.delete(folders).where(and(isNotNull(folders.deletedAt), lt(folders.deletedAt, olderThan), sql`not exists (select 1 from ${files} f where f.folder_id = ${qcol(folders.id)}) and not exists (select 1 from ${folders} c where c.parent_id = ${qcol(folders.id)})`));
    void tenantId;
    return ids.length;
  }

  // -------------------------------------------------------------------------
  // Sharing
  // -------------------------------------------------------------------------

  /** People and roles a file owner/manager can share with (no users.read/roles.read needed). */
  async shareTargets(): Promise<ShareTargets> {
    const { db } = RequestContext.tenant();
    const people = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.status, 'active')).orderBy(asc(users.name));
    const roleRows = await db.select({ id: roles.id, name: roles.name }).from(roles).orderBy(asc(roles.name));
    return { users: people, roles: roleRows };
  }

  private async assertCanShare(ctx: TenantContext, target: { createdBy: string | null }): Promise<void> {
    const isCreator = ctx.actor.type === 'user' && target.createdBy === ctx.actor.userId;
    if (!isCreator && !ctx.permissions.has('files.share')) throw Errors.forbidden('Only the owner or a file manager can change sharing.');
  }

  private async shareTarget(kind: 'file' | 'folder', id: string) {
    const ctx = RequestContext.tenant();
    const idx = await this.accessIndex(ctx);
    const target = kind === 'file' ? await this.liveFile(ctx.db, id) : await this.liveFolder(ctx.db, id);
    this.assertAccess(kind === 'file' ? idx.file(target as typeof files.$inferSelect) : idx.folder(id), 'view');
    return { ctx, target };
  }

  async listShares(kind: 'file' | 'folder', id: string): Promise<FileShareRow[]> {
    const { ctx } = await this.shareTarget(kind, id);
    const rows = await ctx.db.select().from(fileShares).where(kind === 'file' ? eq(fileShares.fileId, id) : eq(fileShares.folderId, id));
    const userNames = await this.people(ctx.db, rows.filter((r) => r.principalType === 'user').map((r) => r.principalId));
    const roleIds = rows.filter((r) => r.principalType === 'role').map((r) => r.principalId);
    const roleNames = new Map(
      (roleIds.length ? await ctx.db.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, roleIds)) : []).map((r) => [r.id, r.name]),
    );
    return rows.map((r) => ({
      id: r.id,
      principalType: r.principalType,
      principalId: r.principalId,
      principalName: (r.principalType === 'user' ? userNames.get(r.principalId)?.name : roleNames.get(r.principalId)) ?? 'Unknown',
      access: r.access,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async addShare(kind: 'file' | 'folder', id: string, input: { principalType: 'user' | 'role'; principalId: string; access: 'view' | 'edit' }): Promise<FileShareRow[]> {
    const { ctx, target } = await this.shareTarget(kind, id);
    await this.assertCanShare(ctx, target);
    const exists =
      input.principalType === 'user'
        ? await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.id, input.principalId), eq(users.status, 'active')))
        : await ctx.db.select({ id: roles.id }).from(roles).where(eq(roles.id, input.principalId));
    if (!exists.length) throw Errors.badRequest('That person or role isn’t in this workspace.');
    await ctx.db.transaction(async (tx) => {
      await tx.delete(fileShares).where(and(kind === 'file' ? eq(fileShares.fileId, id) : eq(fileShares.folderId, id), eq(fileShares.principalId, input.principalId)));
      await tx.insert(fileShares).values({
        ...(kind === 'file' ? { fileId: id } : { folderId: id }),
        principalType: input.principalType,
        principalId: input.principalId,
        access: input.access,
        createdBy: ctx.actor.type === 'user' ? ctx.actor.userId : null,
      });
    });
    await this.audit.tenantEvent({ action: 'files.shared', resourceType: kind, resourceId: id, metadata: input });
    return this.listShares(kind, id);
  }

  async removeShare(kind: 'file' | 'folder', id: string, shareId: string): Promise<void> {
    const { ctx, target } = await this.shareTarget(kind, id);
    await this.assertCanShare(ctx, target);
    const removed = await ctx.db
      .delete(fileShares)
      .where(and(eq(fileShares.id, shareId), kind === 'file' ? eq(fileShares.fileId, id) : eq(fileShares.folderId, id)))
      .returning({ id: fileShares.id });
    if (!removed.length) throw Errors.notFound();
    await this.audit.tenantEvent({ action: 'files.unshared', resourceType: kind, resourceId: id, metadata: { shareId } });
  }
}
