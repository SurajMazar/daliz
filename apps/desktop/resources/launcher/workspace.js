/**
 * Pure launcher logic (no Neutralino calls), shared with the Node tests.
 */

/** Turns what the user typed into a safe workspace origin, or throws a readable error. */
export function normalizeWorkspace(input, { allowInsecureLocalhost = false } = {}) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('Enter your workspace address, for example acme.daliz.com');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That doesn’t look like a web address.');
  }
  if (url.username || url.password) throw new Error('Workspace addresses can’t contain credentials.');
  const localhost = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1';
  if (url.protocol === 'http:' && !(allowInsecureLocalhost && localhost)) throw new Error('Workspace addresses must use https.');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Workspace addresses must use https.');
  if (!localhost && !/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(url.hostname)) {
    throw new Error('That doesn’t look like a valid host name.');
  }
  return url.origin;
}

/** URL the desktop window opens for a workspace. `launcher` lets the app offer "switch workspace". */
export function workspaceEntryUrl(origin, launcherUrl, path = '/') {
  const url = new URL(path.startsWith('/') ? path : '/', origin);
  url.searchParams.set('client', 'desktop');
  if (launcherUrl) url.searchParams.set('launcher', launcherUrl);
  return url.toString();
}

/**
 * Maps a deep link to an in-app route on a workspace the user already added.
 *   daliz://open?workspace=acme.daliz.com&path=/planner?task=123
 *   daliz://tenant/acme/tasks/123   (acme = first label of a known workspace host)
 * Unknown workspaces are refused: a link can never send the app to an arbitrary host.
 * Authentication and authorization still happen in the web app.
 */
export function resolveDeepLink(link, knownOrigins) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'daliz:') return null;
  const find = (host) => knownOrigins.find((o) => new URL(o).hostname === host);
  if (url.hostname === 'open') {
    const origin = find(String(url.searchParams.get('workspace') ?? '').toLowerCase());
    const path = url.searchParams.get('path') ?? '/';
    if (!origin || !path.startsWith('/') || path.startsWith('//')) return null;
    return { origin, path };
  }
  if (url.hostname === 'tenant') {
    const [slug, kind, id] = url.pathname.split('/').filter(Boolean);
    const origin = knownOrigins.find((o) => new URL(o).hostname.split('.')[0] === slug);
    if (!origin) return null;
    const safeId = /^[0-9a-f-]{36}$/i.test(id ?? '') ? id : null;
    const routes = { tasks: safeId ? `/planner?task=${safeId}` : '/planner', events: safeId ? `/events?event=${safeId}` : '/events', files: '/files', dashboard: '/dashboard' };
    return { origin, path: routes[kind] ?? '/dashboard' };
  }
  return null;
}
