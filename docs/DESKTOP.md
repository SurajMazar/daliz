# Desktop app (Neutralino)

One Daliz desktop application for every tenant, wrapping the same React web app. There is no separate desktop UI and no business logic on the client.

## How it works

```
┌──────────────── Daliz desktop window ────────────────┐
│ 1. Local launcher (resources/launcher, bundled)       │  native API: tight allow-list
│    • choose/remember workspace (https only)           │
│    • signed auto-update, rollback                     │
│    • deep links → known workspaces only               │
│    • reachability check + offline screen              │
│                         │ location.replace()          │
│ 2. Remote workspace  https://acme.daliz.com/?client=desktop
│    • the normal web app, same cookie session, CSRF,   │  NO native API
│      MFA, server-side authorization                   │
│    • runtime tenant branding, lock screen, shortcuts   │
└───────────────────────────────────────────────────────┘
```

Why the remote app runs without native APIs: Neutralino only grants its native bridge to the locally served launcher, and our configuration keeps it that way (`injectClientLibrary: false`, one-time token security). If the web app were ever compromised by XSS, it still couldn't read files, run commands or change the installation. The desktop client is treated like any browser: untrusted, holding no secrets, database credentials or signing keys. Authentication is the web app's own session cookie, stored in the webview's cookie jar (HttpOnly, never in localStorage), with the same expiry, revocation and MFA as the web.

Native allow-list (launcher only): `app.getConfig`, `app.exit`, `app.restartProcess`, `storage.getData/setData` (workspace list and update state; no credentials), `filesystem.writeBinaryFile/copy/getStats` (installing a verified update and keeping a backup), `os.showMessageBox`, `window.setTitle/focus`. Explicitly blocked: `os.execCommand`, `os.spawnProcess`, `extensions.*`, `computer.*`.

Desktop capabilities inside the web app use standard web APIs through the web app's platform layer (`X-Daliz-Client: desktop`): file pick/save, clipboard, notifications, keyboard shortcuts, and the inactivity lock screen driven by the tenant's `lockScreenMinutes` policy.

## Tenant branding

Branding is applied at runtime by the web app from the tenant's theme (logo, colors, title), so one signed binary serves every tenant. Tenant data never modifies the executable or native resources.

## Updates

- Most changes need no desktop release: the window loads the web app, which updates server-side.
- Launcher updates are signed: CI builds `resources.neu`, then `scripts/sign-update.mjs` writes `manifest.json` (version, https URL, SHA-256, size, notes, timestamp) signed with ECDSA P-256. The app embeds only the public key (`resources/launcher/update-public-key.json`).
- The launcher checks the manifest on start and refuses anything unsigned, tampered with or not newer. It downloads the bundle, verifies size and hash, backs up the current bundle to `resources.neu.bak`, installs, and restarts. **Restore previous version** appears whenever a backup exists.
- Channels: point `globalVariables.UPDATE_MANIFEST_URL` at `…/development|staging|stable/manifest.json` per build.
- Keys: `pnpm --filter @daliz/desktop keygen` creates the pair. Store the private key only as the `DALIZ_UPDATE_KEY` CI secret. Rotating the key means shipping a full installer that embeds the new public key.
- Binary (runtime) updates ship as signed installers: macOS Developer ID + notarization, and Windows Authenticode (see `.github/workflows/desktop-release.yml`).

## Deep links

`daliz://open?workspace=acme.daliz.com&path=/planner?task=<id>` and `daliz://tenant/acme/tasks/<id>` resolve only to workspaces already added on this device, and only to in-app paths, so a link can never send the app to another host or skip sign-in. The OS protocol handler is registered by the installer: `CFBundleURLTypes` in the macOS app bundle, a `HKCU\Software\Classes\daliz` key on Windows, `MimeType=x-scheme-handler/daliz` in the Linux `.desktop` file. The link reaches the launcher as a launch argument (`NL_ARGS`).

## Build targets

`pnpm --filter @daliz/desktop build` produces `dist/daliz/` with `daliz-mac_arm64`, `daliz-mac_x64`, `daliz-mac_universal`, `daliz-win_x64.exe`, `daliz-linux_x64`, `daliz-linux_arm64`, `daliz-linux_armhf` and `resources.neu`. Icons for every platform come from `assets/brand/daliz-mark.svg` (`pnpm --filter @daliz/desktop icons`).

## Development

```bash
pnpm --filter @daliz/desktop setup   # downloads Neutralino binaries + client library
pnpm --filter @daliz/desktop dev     # runs with the inspector enabled
```

To try it against the local stack, set `"DEFAULT_WORKSPACE": "http://acme.localhost:5173"` and `"ALLOW_INSECURE_LOCALHOST": true` in `neutralino.config.json` (development only; release builds require https).
