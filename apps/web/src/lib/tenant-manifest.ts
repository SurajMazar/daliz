/**
 * Tenant-branded web app manifest, built on the client from public branding. Only validated
 * values go in: hex colors (else the Daliz defaults), a length-limited name, and icon URLs
 * that are same-origin branding asset paths. Everything else falls back to /manifest.webmanifest.
 */
import { DEFAULT_THEME, HEX_COLOR, type PublicBranding } from '@daliz/shared';

const STATIC_MANIFEST = '/manifest.webmanifest';
const ASSET_PREFIX = '/api/v1/public/branding/assets/';
let currentBlobUrl: string | null = null;

function safeColor(value: string | undefined, fallback: string): string {
  const v = (value ?? '').toLowerCase();
  return HEX_COLOR.test(v) ? v : fallback;
}

function safeAssetPath(url: string | undefined): string | null {
  if (!url || !url.startsWith(ASSET_PREFIX) || url.includes('..')) return null;
  try {
    const u = new URL(url, window.location.origin);
    return u.origin === window.location.origin ? u.href : null;
  } catch {
    return null;
  }
}

function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 45);
  return clean || 'Daliz';
}

function manifestLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'manifest';
    document.head.appendChild(link);
  }
  return link;
}

export function applyTenantManifest(branding: PublicBranding | null, displayName?: string): void {
  const link = manifestLink();
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  if (!branding) {
    link.href = STATIC_MANIFEST;
    return;
  }
  const origin = window.location.origin;
  const abs = (p: string) => new URL(p, origin).href;
  const name = safeName(displayName || branding.name);
  const theme = safeColor(branding.theme.primary, DEFAULT_THEME.primary);
  const background = safeColor(branding.theme.background, DEFAULT_THEME.background);
  const icon192 = safeAssetPath(branding.logo?.urls['icon-192']);
  const icon512 = safeAssetPath(branding.logo?.urls['icon-512']);
  const icons =
    icon192 && icon512
      ? [
          { src: icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'any' },
        ]
      : [
          { src: abs('/icons/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: abs('/icons/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: abs('/icons/icon-maskable-512.png'),
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ];
  const manifest = {
    id: abs('/'),
    name,
    short_name: name.length > 12 ? name.slice(0, 12).trim() : name,
    start_url: abs('/?source=pwa'),
    scope: abs('/'),
    display: 'standalone',
    theme_color: theme,
    background_color: background,
    icons,
    shortcuts: [
      { name: 'Dashboard', url: abs('/') },
      { name: 'Planner', url: abs('/planner') },
      { name: 'Daybook', url: abs('/daybook') },
      { name: 'Files', url: abs('/files') },
    ],
  };
  currentBlobUrl = URL.createObjectURL(
    new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }),
  );
  link.href = currentBlobUrl;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', theme);
}
