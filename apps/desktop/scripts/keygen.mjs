/**
 * Creates the update-signing key pair.
 *   - public key  → resources/launcher/update-public-key.json (shipped in the app)
 *   - private key → path from DALIZ_UPDATE_KEY_PATH (default ./update-signing-key.jwk.json),
 *                   which must be moved into the CI secret store and never committed.
 */
import { existsSync, writeFileSync } from 'node:fs';

const out = process.env.DALIZ_UPDATE_KEY_PATH ?? 'update-signing-key.jwk.json';
if (existsSync(out) && !process.argv.includes('--force')) {
  console.error(`${out} exists; pass --force to replace it (this invalidates future updates for installed apps).`);
  process.exit(1);
}
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
writeFileSync('resources/launcher/update-public-key.json', `${JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, null, 2)}\n`);
writeFileSync(out, JSON.stringify(priv), { mode: 0o600 });
console.log(`public key → resources/launcher/update-public-key.json\nprivate key → ${out} (store it as a CI secret, then delete it locally)`);
