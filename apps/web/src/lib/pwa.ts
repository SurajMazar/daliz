/**
 * Service worker registration, update prompt and install prompt.
 * Production builds register /sw.js automatically. In development the worker is only
 * registered on demand (e.g. enabling push), so Vite's dev server is never shadowed.
 */
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { capabilities, getPlatform } from '@/platform';
import { navigateTo } from './navigation';
import { hasUnsavedChanges } from './unsaved';

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

export function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!capabilities.supportsServiceWorker) return Promise.resolve(null);
  if (!registration) {
    registration = navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        watchForUpdates(reg);
        return reg;
      })
      .catch(() => null);
  }
  return registration;
}

let updateShown = false;
function promptUpdate(worker: ServiceWorker) {
  if (updateShown) return;
  updateShown = true;
  toast('Update available', {
    id: 'sw-update',
    description: 'A new version of Daliz is ready.',
    duration: Infinity,
    action: {
      label: 'Reload',
      onClick: () => {
        if (
          hasUnsavedChanges() &&
          !window.confirm('You have unsaved changes. Reload and lose them?')
        ) {
          updateShown = false;
          return;
        }
        // Reload only after the user asked for it, once the new worker has taken over.
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => window.location.reload(),
          { once: true },
        );
        worker.postMessage({ type: 'SKIP_WAITING' });
      },
    },
  });
}

function watchForUpdates(reg: ServiceWorkerRegistration) {
  if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(worker);
    });
  });
  // Check for new versions periodically and when the tab regains focus.
  window.setInterval(() => void reg.update().catch(() => undefined), 30 * 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
  });
}

export function registerServiceWorker(): void {
  if (!capabilities.supportsServiceWorker) return;
  navigator.serviceWorker.addEventListener(
    'message',
    (e: MessageEvent<{ type?: string; link?: string }>) => {
      const link = e.data?.link;
      if (
        e.data?.type === 'NAVIGATE' &&
        typeof link === 'string' &&
        link.startsWith('/') &&
        !link.startsWith('//')
      )
        navigateTo(link);
    },
  );
  if (import.meta.env.PROD) {
    if (document.readyState === 'complete') void ensureServiceWorker();
    else window.addEventListener('load', () => void ensureServiceWorker(), { once: true });
  } else {
    // Dev: re-use an existing registration (e.g. created for push) without forcing one.
    void navigator.serviceWorker.getRegistration().then((reg) => reg && watchForUpdates(reg));
  }
}

// --- Install prompt -----------------------------------------------------------

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();
const emit = () => installListeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
}

export function useInstallPrompt(): { available: boolean; install: () => Promise<void> } {
  const available = useSyncExternalStore(
    (fn) => {
      installListeners.add(fn);
      return () => installListeners.delete(fn);
    },
    () => deferred !== null && getPlatform() === 'WEB',
  );
  return {
    available,
    install: async () => {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice.catch(() => undefined);
      deferred = null;
      emit();
    },
  };
}
