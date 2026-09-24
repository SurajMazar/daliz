/**
 * Platform abstraction: one place that knows whether we run in a browser tab, an installed
 * PWA or the Neutralino desktop shell, and what the environment supports. Everything is
 * feature-detected; the desktop shell grants the web app no native APIs, so it uses the
 * same standard web APIs as a browser.
 */
export type Platform = 'WEB' | 'PWA' | 'DESKTOP';

const DESKTOP_KEY = 'daliz.client';
const LAUNCHER_KEY = 'daliz.launcher';

function safeSession(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Called once at boot: the desktop launcher opens `/?client=desktop&launcher=<url>`. Persist
 * that for this window's session and strip the parameters from the address bar.
 */
export function initPlatformFromUrl(): void {
  const url = new URL(window.location.href);
  const client = url.searchParams.get('client');
  if (client !== 'desktop') return;
  const launcher = url.searchParams.get('launcher');
  const store = safeSession();
  store?.setItem(DESKTOP_KEY, 'desktop');
  if (launcher && isLocalLauncherUrl(launcher)) store?.setItem(LAUNCHER_KEY, launcher);
  url.searchParams.delete('client');
  url.searchParams.delete('launcher');
  window.history.replaceState(window.history.state, '', url.pathname + (url.search ? url.search : '') + url.hash);
}

/** Only loopback launcher URLs are accepted, so the parameter can't become an open redirect. */
export function isLocalLauncherUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && /^\d+$/.test(u.port) && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function launcherUrl(): string | null {
  const v = safeSession()?.getItem(LAUNCHER_KEY) ?? null;
  return v && isLocalLauncherUrl(v) ? v : null;
}

export function getPlatform(): Platform {
  if (safeSession()?.getItem(DESKTOP_KEY) === 'desktop') return 'DESKTOP';
  try {
    if (window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone) return 'PWA';
  } catch {
    // ignore
  }
  return 'WEB';
}

export const capabilities = {
  get supportsServiceWorker() {
    return 'serviceWorker' in navigator && window.isSecureContext;
  },
  get supportsPush() {
    return capabilities.supportsServiceWorker && 'PushManager' in window && 'Notification' in window;
  },
  get supportsNotifications() {
    return 'Notification' in window;
  },
  get supportsOffline() {
    return capabilities.supportsServiceWorker && 'indexedDB' in window;
  },
  get supportsClipboard() {
    return !!navigator.clipboard && window.isSecureContext;
  },
  get supportsFileSystemAccess() {
    return 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
  },
  get supportsInstall() {
    return getPlatform() === 'WEB' && 'BeforeInstallPromptEvent' in window;
  },
};

type SavePickerWindow = Window & {
  showSaveFilePicker?: (opts: { suggestedName?: string }) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
  showOpenFilePicker?: (opts?: { multiple?: boolean }) => Promise<{ getFile: () => Promise<File> }[]>;
};

/** Opens a file picker; resolves null if cancelled. */
export async function pickFile(accept?: string): Promise<File | null> {
  const w = window as SavePickerWindow;
  if (capabilities.supportsFileSystemAccess && !accept && w.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker();
      return handle ? await handle.getFile() : null;
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Saves a blob with the native save dialog when available, else a normal download. */
export async function saveFile(blob: Blob, name: string): Promise<void> {
  const w = window as SavePickerWindow;
  if (capabilities.supportsFileSystemAccess && w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: name });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Opens http(s) links in a new, isolated browsing context. Anything else is ignored. */
export function openExternal(url: string): boolean {
  try {
    const u = new URL(url, window.location.href);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    window.open(u.toString(), '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
}

/** A system notification when permitted (used for local events such as the lock screen). */
export async function notify(title: string, options: NotificationOptions = {}): Promise<boolean> {
  if (!capabilities.supportsNotifications || Notification.permission !== 'granted') return false;
  try {
    const reg = capabilities.supportsServiceWorker ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) await reg.showNotification(title, options);
    else new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}
