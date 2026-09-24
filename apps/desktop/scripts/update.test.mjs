import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importPublicKey, isNewer, sha256Hex, signManifest, verifyManifest, verifyPayload } from '../resources/launcher/update.js';

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
const publicKey = await importPublicKey({ kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y });
const payload = new TextEncoder().encode('resources bundle bytes');
const base = { channel: 'stable', version: '1.2.0', resourcesUrl: 'https://downloads.daliz.example/r.neu', sha256: await sha256Hex(payload), size: payload.byteLength, notes: 'x', publishedAt: '2026-09-24T00:00:00Z' };

test('accepts a correctly signed manifest and payload', async () => {
  const signed = await signManifest(base, pair.privateKey);
  assert.equal(await verifyManifest(signed, publicKey), true);
  assert.equal(await verifyPayload(payload, signed), true);
});

test('rejects tampering with any signed field', async () => {
  const signed = await signManifest(base, pair.privateKey);
  for (const [k, v] of [['version', '9.9.9'], ['resourcesUrl', 'https://evil.example/r.neu'], ['sha256', 'a'.repeat(64)], ['size', 1]]) {
    assert.equal(await verifyManifest({ ...signed, [k]: v }, publicKey), false, k);
  }
});

test('rejects unsigned, foreign-key and insecure manifests', async () => {
  assert.equal(await verifyManifest(base, publicKey), false);
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  assert.equal(await verifyManifest(await signManifest(base, other.privateKey), publicKey), false);
  assert.equal(await verifyManifest(await signManifest({ ...base, resourcesUrl: 'http://downloads.daliz.example/r.neu' }, pair.privateKey), publicKey), false);
});

test('rejects payloads that do not match', async () => {
  const signed = await signManifest(base, pair.privateKey);
  assert.equal(await verifyPayload(new TextEncoder().encode('evil bytes!!!!!!!!!!!!'), signed), false);
});

test('compares versions', () => {
  assert.equal(isNewer('1.10.0', '1.9.3'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.9.9', '1.0.0'), false);
});
