import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeWorkspace, resolveDeepLink, workspaceEntryUrl } from '../resources/launcher/workspace.js';

test('normalizes workspace addresses to https origins', () => {
  assert.equal(normalizeWorkspace('acme.daliz.com'), 'https://acme.daliz.com');
  assert.equal(normalizeWorkspace(' https://finance.acme.com/some/path?x=1 '), 'https://finance.acme.com');
});

test('refuses insecure, credentialed and odd addresses', () => {
  assert.throws(() => normalizeWorkspace('http://acme.daliz.com'), /https/);
  assert.throws(() => normalizeWorkspace('https://user:pw@acme.daliz.com'), /credentials/);
  assert.throws(() => normalizeWorkspace('javascript:alert(1)'), /https|web address/);
  assert.throws(() => normalizeWorkspace('file:///etc/passwd'), /https/);
  assert.throws(() => normalizeWorkspace(''), /Enter/);
  assert.throws(() => normalizeWorkspace('http://acme.localhost:5173'), /https/);
  assert.equal(normalizeWorkspace('http://acme.localhost:5173', { allowInsecureLocalhost: true }), 'http://acme.localhost:5173');
});

test('builds the desktop entry URL', () => {
  assert.equal(workspaceEntryUrl('https://acme.daliz.com', 'http://127.0.0.1:5000/launcher/index.html', '/planner?task=1'), 'https://acme.daliz.com/planner?task=1&client=desktop&launcher=http%3A%2F%2F127.0.0.1%3A5000%2Flauncher%2Findex.html');
});

test('resolves deep links only to known workspaces', () => {
  const known = ['https://acme.daliz.com', 'https://finance.globex.com'];
  assert.deepEqual(resolveDeepLink('daliz://tenant/acme/tasks/0b6f3d8a-6a57-4c1e-9d0e-3d1bb5b3a1f0', known), { origin: 'https://acme.daliz.com', path: '/planner?task=0b6f3d8a-6a57-4c1e-9d0e-3d1bb5b3a1f0' });
  assert.deepEqual(resolveDeepLink('daliz://open?workspace=finance.globex.com&path=/files', known), { origin: 'https://finance.globex.com', path: '/files' });
  assert.equal(resolveDeepLink('daliz://open?workspace=evil.example&path=/', known), null);
  assert.equal(resolveDeepLink('daliz://open?workspace=acme.daliz.com&path=//evil.example', known), null);
  assert.equal(resolveDeepLink('daliz://tenant/evil/tasks/1', known), null);
  assert.equal(resolveDeepLink('https://acme.daliz.com', known), null);
  assert.deepEqual(resolveDeepLink('daliz://tenant/acme/tasks/not-a-uuid', known), { origin: 'https://acme.daliz.com', path: '/planner' });
});
