/**
 * Produces a signed update manifest for a built resources bundle.
 *   DALIZ_UPDATE_KEY=<private JWK json> node scripts/sign-update.mjs \
 *     --resources dist/daliz/resources.neu --version 1.1.0 \
 *     --url https://downloads.daliz.example/desktop/stable/1.1.0/resources.neu \
 *     --channel stable --notes "Faster start-up" > manifest.json
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sha256Hex, signManifest } from '../resources/launcher/update.js';

const { values } = parseArgs({
  options: {
    resources: { type: 'string' },
    version: { type: 'string' },
    url: { type: 'string' },
    channel: { type: 'string', default: 'stable' },
    notes: { type: 'string', default: '' },
  },
});
for (const k of ['resources', 'version', 'url']) if (!values[k]) throw new Error(`--${k} is required`);
if (!/^https:\/\//.test(values.url)) throw new Error('--url must be https');
const keyJson = process.env.DALIZ_UPDATE_KEY ?? readFileSync(process.env.DALIZ_UPDATE_KEY_PATH ?? 'update-signing-key.jwk.json', 'utf8');
const privateKey = await crypto.subtle.importKey('jwk', JSON.parse(keyJson), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
const bytes = readFileSync(values.resources);
const manifest = await signManifest(
  {
    channel: values.channel,
    version: values.version,
    resourcesUrl: values.url,
    sha256: await sha256Hex(bytes),
    size: bytes.byteLength,
    notes: values.notes,
    publishedAt: new Date().toISOString(),
  },
  privateKey,
);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
