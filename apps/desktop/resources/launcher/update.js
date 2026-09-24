/**
 * Verified desktop updates. Shared by the launcher (webview) and the release scripts/tests
 * (Node 24), using only WebCrypto.
 *
 * A release publishes manifest.json:
 *   { channel, version, resourcesUrl, sha256, size, notes, publishedAt, signature }
 * `signature` is ECDSA P-256 / SHA-256 (IEEE P1363, base64) over the canonical manifest
 * (every other field, keys sorted, JSON). The launcher embeds only the public key, refuses
 * anything unsigned, tampered with, not newer, or whose bytes don't match `sha256`/`size`.
 */

const SIGNED_FIELDS = ['channel', 'version', 'resourcesUrl', 'sha256', 'size', 'notes', 'publishedAt'];

export function canonicalManifest(manifest) {
  const out = {};
  for (const k of SIGNED_FIELDS) {
    if (!(k in manifest)) throw new Error(`manifest is missing "${k}"`);
    out[k] = manifest[k];
  }
  return JSON.stringify(out);
}

const b64 = {
  encode: (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))),
  decode: (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
};

export async function importPublicKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

export async function signManifest(manifest, privateKey) {
  const data = new TextEncoder().encode(canonicalManifest(manifest));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
  return { ...manifest, signature: b64.encode(sig) };
}

export async function verifyManifest(manifest, publicKey) {
  if (!manifest || typeof manifest.signature !== 'string') return false;
  if (!/^https:\/\//.test(manifest.resourcesUrl)) return false;
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256)) return false;
  let sig;
  try {
    sig = b64.decode(manifest.signature);
  } catch {
    return false;
  }
  const data = new TextEncoder().encode(canonicalManifest(manifest));
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, data);
}

/** Semver-ish comparison of "major.minor.patch". */
export function isNewer(candidate, current) {
  const parse = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Checks downloaded bytes against a verified manifest. */
export async function verifyPayload(bytes, manifest) {
  if (bytes.byteLength !== manifest.size) return false;
  return (await sha256Hex(bytes)) === manifest.sha256;
}
