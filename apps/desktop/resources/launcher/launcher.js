/**
 * Daliz desktop launcher. This local page is the only code with native API access (see the
 * allow-list in neutralino.config.json). It chooses a workspace, checks for signed updates,
 * then opens the remote Daliz web app in this window. The web app itself never receives
 * native APIs: it authenticates with the same session cookies as in a browser and runs the
 * same server-side authorization.
 */
import { importPublicKey, isNewer, verifyManifest, verifyPayload } from './update.js';
import { normalizeWorkspace, resolveDeepLink, workspaceEntryUrl } from './workspace.js';

const $ = (id) => document.getElementById(id);
const show = (id) => ['chooser', 'connecting', 'offline'].forEach((s) => ($(s).hidden = s !== id));
let config = { UPDATE_MANIFEST_URL: '', DEFAULT_WORKSPACE: '', ALLOW_INSECURE_LOCALHOST: false };
let pendingOrigin = null;

async function getJson(key, fallback) {
  try {
    return JSON.parse(await Neutralino.storage.getData(key));
  } catch {
    return fallback;
  }
}
const setJson = (key, value) => Neutralino.storage.setData(key, JSON.stringify(value));

async function recentWorkspaces() {
  const list = await getJson('workspaces', []);
  return Array.isArray(list) ? list.filter((w) => typeof w?.origin === 'string') : [];
}

async function remember(origin) {
  const list = (await recentWorkspaces()).filter((w) => w.origin !== origin);
  list.unshift({ origin, lastUsed: new Date().toISOString() });
  await setJson('workspaces', list.slice(0, 8));
}

async function reachable(origin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // Opaque (no-cors) request: we only learn whether the host answers, nothing more.
    await fetch(`${origin}/api/v1/health/live`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function open(origin, path = '/') {
  pendingOrigin = origin;
  $('connecting-host').textContent = new URL(origin).host;
  show('connecting');
  if (!(await reachable(origin))) {
    show('offline');
    return;
  }
  await remember(origin);
  await Neutralino.window.setTitle('Daliz');
  const launcher = `${location.origin}${location.pathname}?choose=1`;
  location.replace(workspaceEntryUrl(origin, launcher, path));
}

async function renderChooser(prefill = '') {
  show('chooser');
  const input = $('workspace');
  input.value = prefill;
  const recent = await recentWorkspaces();
  $('recent-wrap').hidden = recent.length === 0;
  const ul = $('recent');
  ul.replaceChildren(
    ...recent.map((w) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = new URL(w.origin).host;
      b.addEventListener('click', () => open(w.origin));
      li.append(b);
      return li;
    }),
  );
  input.focus();
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

async function checkForUpdate() {
  if (!config.UPDATE_MANIFEST_URL || window.NL_RESMODE !== 'bundle') return; // dev builds don't self-update
  try {
    const keyJwk = await (await fetch('update-public-key.json')).json();
    const key = await importPublicKey(keyJwk);
    const manifest = await (await fetch(config.UPDATE_MANIFEST_URL, { cache: 'no-store', credentials: 'omit' })).json();
    if (!(await verifyManifest(manifest, key))) {
      await Neutralino.debug?.log?.('Rejected an update manifest with an invalid signature', 'WARNING');
      return;
    }
    if (!isNewer(manifest.version, window.NL_APPVERSION)) return;
    $('update-title').textContent = `Version ${manifest.version} is available`;
    $('update-notes').textContent = manifest.notes || '';
    $('update').hidden = false;
    $('update-install').onclick = () => installUpdate(manifest);
  } catch {
    // Update checks never block using the app.
  }
}

async function installUpdate(manifest) {
  const button = $('update-install');
  button.disabled = true;
  button.textContent = 'Downloading…';
  try {
    const bytes = await (await fetch(manifest.resourcesUrl, { cache: 'no-store', credentials: 'omit' })).arrayBuffer();
    if (!(await verifyPayload(bytes, manifest))) throw new Error('The download didn’t match its signature.');
    const current = `${window.NL_PATH}/resources.neu`;
    await Neutralino.filesystem.copy(current, `${current}.bak`, { overwrite: true });
    await Neutralino.filesystem.writeBinaryFile(current, bytes);
    await setJson('pendingUpdate', { version: manifest.version, from: window.NL_APPVERSION, at: new Date().toISOString() });
    await Neutralino.app.restartProcess();
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Install and restart';
    await Neutralino.os.showMessageBox('Update failed', `${err.message ?? err}. Your current version is unchanged.`, 'OK', 'WARNING');
  }
}

async function offerRollback() {
  try {
    await Neutralino.filesystem.getStats(`${window.NL_PATH}/resources.neu.bak`);
  } catch {
    return;
  }
  $('rollback').hidden = false;
  $('rollback').onclick = async () => {
    const choice = await Neutralino.os.showMessageBox('Restore previous version', 'Go back to the version you had before the last update?', 'YES_NO', 'QUESTION');
    if (choice !== 'YES') return;
    const current = `${window.NL_PATH}/resources.neu`;
    await Neutralino.filesystem.copy(`${current}.bak`, current, { overwrite: true });
    await Neutralino.app.restartProcess();
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  Neutralino.init();
  $('version').textContent = `Desktop ${window.NL_APPVERSION ?? ''}`.trim();
  try {
    const cfg = await Neutralino.app.getConfig();
    config = { ...config, ...(cfg.globalVariables ?? {}) };
  } catch {
    /* keep defaults */
  }
  const pending = await getJson('pendingUpdate', null);
  if (pending && pending.version === window.NL_APPVERSION) await setJson('pendingUpdate', null);
  void checkForUpdate();
  void offerRollback();

  $('workspace-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      $('workspace-error').textContent = '';
      await open(normalizeWorkspace($('workspace').value, { allowInsecureLocalhost: !!config.ALLOW_INSECURE_LOCALHOST }));
    } catch (err) {
      $('workspace-error').textContent = err.message;
    }
  });
  $('retry').addEventListener('click', () => pendingOrigin && open(pendingOrigin));
  $('choose-other').addEventListener('click', () => renderChooser());

  const recent = await recentWorkspaces();
  const args = Array.isArray(window.NL_ARGS) ? window.NL_ARGS : [];
  const deepLink = args.find((a) => typeof a === 'string' && a.startsWith('daliz://'));
  const target = deepLink ? resolveDeepLink(deepLink, recent.map((w) => w.origin)) : null;
  if (target) return open(target.origin, target.path);

  const forceChooser = new URLSearchParams(location.search).has('choose');
  if (!forceChooser && recent[0]) return open(recent[0].origin);
  return renderChooser(forceChooser ? '' : config.DEFAULT_WORKSPACE || '');
}

main();
