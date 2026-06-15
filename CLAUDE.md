# CLAUDE.md

Guidance for working in this repo. Keep it short and current.

## What this is

An unofficial **Messenger desktop client for macOS**, built with Electron. It
wraps `https://www.facebook.com/messages` in native windows and adds a floating
chat bubble, an in-app document viewer, auto-updates, and a settings panel.
There is no build step for the app code — it's plain JS/HTML loaded directly by
Electron. `main.js` is the whole main process (~1200 lines); the rest are small
preloads and HTML pages.

## Run & build

- `npm start` — run from source (`electron .`). Use this for development.
- `npm run build` — package the macOS app with electron-builder (unsigned-ish, local).
- `npm run release` — interactive release: bumps version, regenerates
  `CHANGELOG.md` from git log, builds + **signs + notarizes**, commits, tags,
  pushes, and creates a GitHub release. Requires a `.env` with
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`,
  `GH_TOKEN`. The notarization step (`notarytool ... --wait`) can sit silently
  for several minutes — that is normal, not a hang.
- `npm run release:rebuild` — rebuild + re-upload assets for the current version.

Commit/push only when asked; `npm run release` already does its own commit+push.

## Architecture (all in `main.js`)

Windows (each created by a `create*` function):
- **Main window** (`createWindow`) — full Messenger window. Persistent session
  partition `persist:messenger`. On close it **hides** instead of quitting (macOS).
- **Bubble** (`createBubbleWindow`) — frameless `type: 'panel'`, always-on-top
  floating chat bubble shown on all workspaces. Toggle via settings.
- **Chat panel** (`createChatPanel`) — compact Messenger window anchored to the
  bubble. Same `persist:messenger` partition.
- **Viewer** (`createViewerWindow` / `openAttachmentViewer`) — in-app preview for
  PDF (native Chromium) and Word (`.docx` via `mammoth`; `.doc` falls back to OS).
- **Settings** (`openSettingsWindow`).

Other key pieces: `setupDownloads` (download routing, see below), `autoUpdater`
(electron-updater, manual download/install), `migrateSession` (one-time cookie
migration to the named partition), unread-count badge from window titles.

Preloads use `contextBridge` (contextIsolation on, nodeIntegration off):
`preload.js` (main, minimal), `bubble-preload.js`, `chat-panel-preload.js`,
`viewer-preload.js`, `settings-preload.js`. IPC channels are `bubble-*`,
`chat-panel-*`, `viewer-*`, `settings-*`, `main-header-*`.

Persisted state (`electron-store`): `windowBounds`, `bubblePosition`,
`bubbleEnabled`, `sessionMigrated`.

## Gotchas — read before changing these

- **Dock icons: never touch `app.dock.*` or `app.setActivationPolicy(...)` to fix
  a duplicate/missing icon.** Duplicate Dock icons come from **multiple running
  instances** (the app hides instead of quitting and is guarded by
  `app.requestSingleInstanceLock()`), not from activation policy. Dock/activation
  manipulation reliably regresses — see the `Remove dock hide feature...` commit
  and the painful history around this. A missing icon under `npm start` is a
  dev-mode artifact; the packaged app shows its single icon on its own.
- **Downloads / attachments**: external links go through `setWindowOpenHandler` /
  `will-navigate`. Never pass `blob:`/`data:` URLs to `shell.openExternal`
  (macOS shows a "no application set to open the URL" dialog) — use
  `openExternalSafe`, which only opens http(s); `blob:` targets are routed to
  `webContents.downloadURL`. `setupDownloads` stages **every** download to a temp
  cache dir, then classifies by extension → MIME → file content (PDF magic bytes)
  in `resolvePreviewKind` and either opens the viewer or moves it to Downloads.
  This layered detection exists because blob downloads often lack a filename/MIME.
- **macOS quit semantics**: closing windows does not quit the app; only the
  explicit Quit menu / `before-quit` sets `isQuitting = true`. Don't assume
  window-close == exit.

## Memory

Project-specific lessons are in
`~/.claude/projects/-Users-vinh-Documents-GitHub-Messenger/memory/` (indexed by
`MEMORY.md`) — notably the Dock-icon gotcha above.
