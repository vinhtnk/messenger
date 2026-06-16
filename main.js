const { app, BrowserWindow, shell, Menu, dialog, session, ipcMain, screen, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const store = new Store();

const MESSENGER_URL = 'https://www.facebook.com/messages';

// URLs allowed for in-app navigation (Messenger + login/auth flows)
function isAllowedUrl(url) {
  const allowed = [
    'https://www.facebook.com/messages',
    'https://facebook.com/messages',
    'https://www.facebook.com/login',
    'https://www.facebook.com/checkpoint',
    'https://www.facebook.com/two_factor',
    'https://www.facebook.com/recover',
    'https://www.facebook.com/cookie',
    'https://www.facebook.com/privacy',
    'https://www.facebook.com/dialog',
    'https://m.facebook.com/login',
    'https://www.messenger.com/',
    'https://www.fbsbx.com/',
    'https://static.xx.fbcdn.net/',
  ];
  return allowed.some(prefix => url.startsWith(prefix));
}

function isFacebookDomain(url) {
  return (
    url.startsWith('https://www.facebook.com/') ||
    url.startsWith('https://facebook.com/') ||
    url.startsWith('https://m.facebook.com/') ||
    url.startsWith('https://www.messenger.com/') ||
    url.startsWith('https://www.fbsbx.com/') ||
    url.startsWith('https://static.xx.fbcdn.net/')
  );
}

function shouldAllowNavigation(url) {
  return isAllowedUrl(url) || isFacebookDomain(url);
}

// Parse unread count from a Messenger/Facebook page title.
// Returns the count, or null if the title isn't recognized so we don't
// overwrite a real count with 0 during transient loads.
function parseUnreadCount(title) {
  if (!title) return null;
  const match = title.match(/\((\d+)\+?\)/);
  if (match) return parseInt(match[1], 10);
  if (/messenger|facebook/i.test(title)) return 0;
  return null;
}

function reportUnreadFromTitle(wc, title) {
  const parsed = parseUnreadCount(title);
  if (parsed === null) return;
  unreadByWebContents.set(wc.id, parsed);
  let count = 0;
  for (const v of unreadByWebContents.values()) {
    if (v > count) count = v;
  }
  lastBadgeCount = count;
  if (app.setBadgeCount) app.setBadgeCount(count);
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.webContents.send('badge-update', count);
  }
}

// Documents we can preview in-app: PDFs (native Chromium viewer) and
// Word files (.docx rendered via mammoth; .doc falls back to the OS app).
const PREVIEWABLE_EXTS = ['.pdf', '.doc', '.docx'];

// blob: downloads often arrive without a filename extension, so we also map
// the MIME type to an extension to recover the real type.
const MIME_TO_EXT = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
};

// Ensure a download has a usable extension: keep the existing one, else derive
// it from the MIME type so previewable docs are still recognized.
function ensureFilenameExtension(filename, mimeType) {
  const name = filename || 'attachment';
  if (path.extname(name)) return name;
  const ext = MIME_TO_EXT[mimeType];
  return ext ? `${name}${ext}` : name;
}

// A "_blank"/window.open target that points at a previewable document — we
// download it in-app (-> will-download -> viewer) instead of the OS browser.
function looksLikeAttachmentUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return PREVIEWABLE_EXTS.includes(ext);
  } catch (e) {
    return false;
  }
}

function isMessengerUrl(url) {
  return (
    url.startsWith('https://www.facebook.com/messages') ||
    url.startsWith('https://facebook.com/messages') ||
    url.startsWith('https://www.messenger.com/')
  );
}

// Only hand real web URLs to the OS. blob:/data:/about: URLs are scoped to the
// renderer that created them — the OS can't open them and macOS shows a
// "There is no application set to open the URL" dialog if we try.
function openExternalSafe(url) {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    shell.openExternal(url);
  }
}

let mainWindow;
let bubbleWindow = null;
let settingsWindow = null;
let chatPanelWindow = null;
let isQuitting = false;
let lastBadgeCount = 0;
const unreadByWebContents = new Map();

const CHAT_PANEL_WIDTH = 400;
const CHAT_PANEL_HEIGHT = 580;
const BUBBLE_SIZE = 88;

// One-time migration of cookies from default session to named persistent partition
async function migrateSession() {
  if (store.get('sessionMigrated')) return;

  const defaultSession = session.defaultSession;
  const messengerSession = session.fromPartition('persist:messenger');

  try {
    const cookies = await defaultSession.cookies.get({});
    for (const cookie of cookies) {
      try {
        const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
        const url = `https://${domain}${cookie.path || '/'}`;
        await messengerSession.cookies.set({ ...cookie, url });
      } catch (e) {
        // Skip cookies that fail to migrate
      }
    }
  } catch (e) {
    console.error('Session migration error:', e);
  }

  store.set('sessionMigrated', true);
}

function uniquePath(dir, filename, fallbackBase) {
  const ext = path.extname(filename) || '';
  const base = path.basename(filename, ext) || fallbackBase;
  let candidate = path.join(dir, `${base}${ext}`);
  let n = 1;
  while (fs.existsSync(candidate) && n < 1000) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n++;
  }
  return candidate;
}

function uniqueDownloadPath(filename) {
  return uniquePath(app.getPath('downloads'), filename, 'image');
}

function isPreviewableAttachment(filename) {
  return PREVIEWABLE_EXTS.includes(path.extname(filename).toLowerCase());
}

function attachmentCachePath(filename) {
  const dir = path.join(app.getPath('temp'), 'Messenger Attachments');
  fs.mkdirSync(dir, { recursive: true });
  return uniquePath(dir, filename, 'attachment');
}

function setupDownloads(targetSession) {
  if (targetSession.__msgrDownloadsWired) return;
  targetSession.__msgrDownloadsWired = true;

  targetSession.on('will-download', (_event, item) => {
    // Recover a real extension for blob downloads that arrive without one,
    // otherwise previewable docs get misrouted to Downloads.
    const filename = ensureFilenameExtension(item.getFilename(), item.getMimeType());
    const mimeType = item.getMimeType();

    // Stage EVERY download in a cache dir first. We can't reliably tell a
    // previewable doc apart until the bytes land (blob downloads often lack a
    // filename extension and MIME), so we sniff the file once it completes and
    // either open the in-app viewer or move it to Downloads + reveal in Finder.
    const savePath = attachmentCachePath(filename);
    item.setSavePath(savePath);
    item.once('done', (_e, state) => {
      if (state !== 'completed') {
        console.error('Download failed:', state, savePath);
        return;
      }
      routeCompletedDownload(savePath, filename, mimeType);
    });
  });
}

// PDF magic bytes ("%PDF"); used to detect PDFs whose filename/MIME were
// stripped by a blob download.
function sniffIsPdf(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf.toString('latin1') === '%PDF';
  } catch (e) {
    return false;
  }
}

// A .docx is a ZIP archive ("PK") containing a "word/document.xml" entry. The
// entry name is stored uncompressed, so we can find it by scanning the raw
// bytes — used to detect Word docs whose filename/MIME were stripped by a blob
// download. (xlsx/pptx are also ZIPs but use "xl/"/"ppt/", so this won't match.)
function sniffIsDocx(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const probe = Math.min(size, 64 * 1024);
    // Read the head (local file headers, in order) and the tail (central
    // directory lists every entry) — covers small and large docx alike.
    const head = Buffer.alloc(probe);
    fs.readSync(fd, head, 0, probe, 0);
    if (head.slice(0, 2).toString('latin1') !== 'PK') return false;
    if (head.toString('latin1').includes('word/document.xml')) return true;

    const tail = Buffer.alloc(probe);
    fs.readSync(fd, tail, 0, probe, Math.max(0, size - probe));
    return tail.toString('latin1').includes('word/document.xml');
  } catch (e) {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Resolve a completed download to a preview kind: 'pdf', 'word', or null
// (not previewable). Checks extension, then MIME, then file content.
function resolvePreviewKind(filePath, filename, mimeType) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.doc' || ext === '.docx') return 'word';

  const mimeExt = MIME_TO_EXT[mimeType];
  if (mimeExt === '.pdf') return 'pdf';
  if (mimeExt === '.doc' || mimeExt === '.docx') return 'word';

  if (sniffIsPdf(filePath)) return 'pdf';
  if (sniffIsDocx(filePath)) return 'word';
  return null;
}

function routeCompletedDownload(filePath, filename, mimeType) {
  const kind = resolvePreviewKind(filePath, filename, mimeType);

  if (kind) {
    openAttachmentViewer(filePath, filename, kind);
    return;
  }

  // Not previewable: move out of the cache into Downloads and reveal it.
  const dest = uniqueDownloadPath(filename);
  try {
    try {
      fs.renameSync(filePath, dest);
    } catch (e) {
      // rename fails across volumes (temp vs Downloads) — fall back to copy.
      fs.copyFileSync(filePath, dest);
      fs.unlinkSync(filePath);
    }
    shell.showItemInFolder(dest);
  } catch (err) {
    console.error('Failed to move download to Downloads:', err);
    shell.showItemInFolder(filePath);
  }
}

// Maps a viewer window's webContents id -> { filePath, filename } so the
// "Save a copy" / "Open in default app" actions know what file to act on.
const viewerFiles = new Map();

async function openAttachmentViewer(filePath, filename, kind) {
  const ext = path.extname(filename).toLowerCase();
  if (!kind) kind = ext === '.pdf' ? 'pdf' : 'word';
  let payload;

  if (kind === 'pdf') {
    payload = { kind: 'pdf', fileUrl: pathToFileURL(filePath).href, filename };
  } else {
    // Word: render .docx with mammoth; .doc (legacy binary) isn't supported,
    // so surface a friendly fallback to open it in the system app.
    try {
      const mammoth = require('mammoth');
      const { value } = await mammoth.convertToHtml({ path: filePath });
      payload = { kind: 'html', html: value, filename };
    } catch (err) {
      console.error('Word preview failed:', err);
      payload = {
        kind: 'error',
        filename,
        message:
          ext === '.doc'
            ? 'Legacy .doc files can’t be previewed in-app. Open it in your default app instead.'
            : 'This document couldn’t be previewed in-app. Open it in your default app instead.',
      };
    }
  }

  createViewerWindow(payload, filePath, filename);
}

function createViewerWindow(payload, filePath, filename) {
  const viewer = new BrowserWindow({
    width: 820,
    height: 900,
    minWidth: 480,
    minHeight: 400,
    title: filename,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'viewer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true,
    },
  });

  viewerFiles.set(viewer.webContents.id, { filePath, filename });

  viewer.loadFile('viewer.html');
  viewer.webContents.once('did-finish-load', () => {
    viewer.webContents.send('viewer-data', payload);
  });

  setupContextMenu(viewer);

  viewer.on('closed', () => {
    viewerFiles.delete(viewer.webContents.id);
  });
}

function setupContextMenu(win) {
  win.webContents.on('context-menu', (_event, params) => {
    const items = [];

    if (params.hasImageContents && params.srcURL) {
      items.push(
        {
          label: 'Save Image',
          click: () => win.webContents.downloadURL(params.srcURL),
        },
        {
          label: 'Copy Image',
          click: () => win.webContents.copyImageAt(params.x, params.y),
        },
        {
          label: 'Copy Image Address',
          click: () => clipboard.writeText(params.srcURL),
        },
      );
    }

    if (params.linkURL && !params.hasImageContents) {
      if (items.length) items.push({ type: 'separator' });
      items.push(
        {
          label: 'Copy Link',
          click: () => clipboard.writeText(params.linkURL),
        },
        {
          label: 'Open Link in Browser',
          click: () => shell.openExternal(params.linkURL),
        },
      );
    }

    if (params.selectionText && params.selectionText.trim()) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ role: 'copy' });
    }

    if (params.isEditable) {
      if (items.length) items.push({ type: 'separator' });
      items.push(
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      );
    }

    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function createWindow() {
  const windowBounds = store.get('windowBounds', {
    width: 1200,
    height: 800,
    x: undefined,
    y: undefined,
  });

  mainWindow = new BrowserWindow({
    width: windowBounds.width,
    height: windowBounds.height,
    x: windowBounds.x,
    y: windowBounds.y,
    minWidth: 400,
    minHeight: 600,
    icon: path.join(__dirname, 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:messenger',
    },
    title: 'Messenger',
  });

  // Save window bounds on resize and move
  mainWindow.on('resize', () => {
    store.set('windowBounds', mainWindow.getBounds());
  });

  mainWindow.on('move', () => {
    store.set('windowBounds', mainWindow.getBounds());
  });

  mainWindow.loadURL(MESSENGER_URL);

  setupContextMenu(mainWindow);

  // Handle new window requests (target="_blank" links)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('blob:') || looksLikeAttachmentUrl(url)) {
      // blob: targets are in-renderer document/file attachments — download
      // them in-app (-> will-download -> viewer) rather than to the OS.
      mainWindow.webContents.downloadURL(url);
    } else if (!isMessengerUrl(url)) {
      openExternalSafe(url);
    }
    return { action: 'deny' };
  });

  // Handle navigation to external sites
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Block Facebook media/photo URLs - these should use the in-page overlay
    if (url.startsWith('https://www.facebook.com/messenger_media') ||
        url.startsWith('https://www.facebook.com/photo') ||
        url.startsWith('https://www.facebook.com/reel') ||
        url.startsWith('https://www.facebook.com/watch')) {
      event.preventDefault();
      return;
    }

    if (url.startsWith('blob:')) {
      event.preventDefault();
      mainWindow.webContents.downloadURL(url);
      return;
    }

    if (!shouldAllowNavigation(url)) {
      event.preventDefault();
      openExternalSafe(url);
    }
  });

  // Inject JS to intercept link clicks for non-Messenger URLs in chat
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      document.addEventListener('click', function(e) {
        const link = e.target.closest('a[href]');
        if (!link) return;

        const href = link.href;
        if (!href || href.startsWith('javascript:') || href.startsWith('#')) return;

        if (href.startsWith('https://www.facebook.com/messages') ||
            href.startsWith('https://facebook.com/messages') ||
            href.startsWith('https://www.messenger.com/') ||
            href.startsWith('https://www.facebook.com/messenger_media') ||
            href.startsWith('https://www.facebook.com/photo')) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        window.open(href, '_blank');
      }, true);
    `);
  });

  mainWindow.webContents.on('page-title-updated', (_event, title) => {
    reportUnreadFromTitle(mainWindow.webContents, title);
  });

  // Hide window instead of closing on macOS (unless quitting)
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function getDefaultBubblePosition() {
  const padding = 50;
  const display = screen.getPrimaryDisplay();
  const work = display.workArea;
  return {
    x: work.x + work.width - BUBBLE_SIZE - padding,
    y: work.y + padding,
  };
}

function createBubbleWindow() {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) return;

  const saved = store.get('bubblePosition', null);
  const pos =
    saved && typeof saved.x === 'number' && typeof saved.y === 'number'
      ? saved
      : getDefaultBubblePosition();

  bubbleWindow = new BrowserWindow({
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: 'panel',
    acceptFirstMouse: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'bubble-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  bubbleWindow.setAlwaysOnTop(true, 'floating');
  bubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  bubbleWindow.loadFile('bubble.html');

  bubbleWindow.webContents.once('did-finish-load', () => {
    bubbleWindow.webContents.send('badge-update', lastBadgeCount);
  });

  bubbleWindow.on('move', () => {
    if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
    const [x, y] = bubbleWindow.getPosition();
    store.set('bubblePosition', { x, y });
  });

  bubbleWindow.on('closed', () => {
    bubbleWindow = null;
  });
}

function destroyBubbleWindow() {
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.close();
  }
  bubbleWindow = null;
}

function getChatPanelBounds() {
  const w = CHAT_PANEL_WIDTH;
  const h = CHAT_PANEL_HEIGHT;
  if (!bubbleWindow || bubbleWindow.isDestroyed()) {
    return { width: w, height: h };
  }
  const [bx, by] = bubbleWindow.getPosition();
  const display = screen.getDisplayNearestPoint({ x: bx, y: by });
  const work = display.workArea;

  let x = bx - w - 8;
  if (x < work.x) x = bx + BUBBLE_SIZE + 8;
  if (x + w > work.x + work.width) x = work.x + work.width - w - 8;

  let y = by;
  if (y + h > work.y + work.height) y = work.y + work.height - h - 8;
  if (y < work.y) y = work.y + 8;

  return { x, y, width: w, height: h };
}

function createChatPanel() {
  if (chatPanelWindow && !chatPanelWindow.isDestroyed()) return;

  chatPanelWindow = new BrowserWindow({
    ...getChatPanelBounds(),
    minWidth: 340,
    minHeight: 480,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Messenger',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'chat-panel-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:messenger',
    },
  });

  chatPanelWindow.setAlwaysOnTop(true, 'floating');
  chatPanelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  chatPanelWindow.loadURL(MESSENGER_URL);

  setupContextMenu(chatPanelWindow);

  chatPanelWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('blob:') || looksLikeAttachmentUrl(url)) {
      chatPanelWindow.webContents.downloadURL(url);
    } else if (!isMessengerUrl(url)) {
      openExternalSafe(url);
    }
    return { action: 'deny' };
  });

  chatPanelWindow.webContents.on('will-navigate', (event, url) => {
    if (
      url.startsWith('https://www.facebook.com/messenger_media') ||
      url.startsWith('https://www.facebook.com/photo') ||
      url.startsWith('https://www.facebook.com/reel') ||
      url.startsWith('https://www.facebook.com/watch')
    ) {
      event.preventDefault();
      return;
    }
    if (url.startsWith('blob:')) {
      event.preventDefault();
      chatPanelWindow.webContents.downloadURL(url);
      return;
    }
    if (!shouldAllowNavigation(url)) {
      event.preventDefault();
      openExternalSafe(url);
    }
  });


  const panelWcId = chatPanelWindow.webContents.id;
  chatPanelWindow.webContents.on('page-title-updated', (_event, title) => {
    reportUnreadFromTitle(chatPanelWindow.webContents, title);
  });
  chatPanelWindow.once('closed', () => {
    unreadByWebContents.delete(panelWcId);
  });

  chatPanelWindow.on('show', () => {
    cancelPendingBubbleShow();
    updateBubbleVisibility();
  });
  chatPanelWindow.on('hide', () => {
    updateBubbleVisibility();
  });

  chatPanelWindow.on('close', (e) => {
    if (!isQuitting && chatPanelWindow) {
      e.preventDefault();
      chatPanelWindow.hide();
    }
  });

  chatPanelWindow.on('closed', () => {
    chatPanelWindow = null;
  });
}

function showChatPanel() {
  cancelPendingBubbleShow();
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    mainWindow.hide();
  }
  if (!chatPanelWindow || chatPanelWindow.isDestroyed()) {
    createChatPanel();
  } else {
    chatPanelWindow.setBounds(getChatPanelBounds());
    chatPanelWindow.show();
  }
  chatPanelWindow.focus();
  updateBubbleVisibility();
}

function hideChatPanel() {
  if (chatPanelWindow && !chatPanelWindow.isDestroyed()) {
    chatPanelWindow.hide();
  }
}

function toggleChatPanel() {
  const visible =
    chatPanelWindow && !chatPanelWindow.isDestroyed() && chatPanelWindow.isVisible();
  if (visible) hideChatPanel();
  else showChatPanel();
}

function shouldHideBubbleForFocus() {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused) return false;
  if (focused === mainWindow) return true;
  if (focused === settingsWindow) return true;
  return false;
}

function updateBubbleVisibility() {
  const enabled = store.get('bubbleEnabled', true);

  if (!enabled) {
    if (bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible()) {
      bubbleWindow.hide();
    }
    return;
  }

  if (!bubbleWindow || bubbleWindow.isDestroyed()) {
    createBubbleWindow();
  }

  if (shouldHideBubbleForFocus()) {
    if (bubbleWindow.isVisible()) bubbleWindow.hide();
  } else {
    if (!bubbleWindow.isVisible()) bubbleWindow.showInactive();
  }

  // Showing the type:'panel' bubble can flip the app into a macOS accessory
  // state and drop the Dock icon. Re-assert 'regular' to keep the Dock icon.
  // (setActivationPolicy only — never app.dock toggling, which duplicates it.)
  if (process.platform === 'darwin') {
    app.setActivationPolicy('regular');
  }
}

function toggleBubble() {
  const enabled = store.get('bubbleEnabled', true);
  applySettings({ bubbleEnabled: !enabled });
}

function showMainWindow() {
  cancelPendingBubbleShow();
  if (bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible()) {
    bubbleWindow.hide();
  }
  hideChatPanel();
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

ipcMain.handle('bubble-get-position', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? win.getPosition() : [0, 0];
});

let dragPanelOffset = null;
let dragResetTimer = null;

ipcMain.on('bubble-set-position', (e, x, y) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;

  const panelFollowing =
    chatPanelWindow && !chatPanelWindow.isDestroyed() && chatPanelWindow.isVisible();

  if (panelFollowing && !dragPanelOffset) {
    const [bx, by] = win.getPosition();
    const [px, py] = chatPanelWindow.getPosition();
    dragPanelOffset = { x: px - bx, y: py - by };
  }

  const nx = Math.round(x);
  const ny = Math.round(y);
  win.setPosition(nx, ny);

  if (panelFollowing && dragPanelOffset) {
    chatPanelWindow.setPosition(nx + dragPanelOffset.x, ny + dragPanelOffset.y);
  }

  if (dragResetTimer) clearTimeout(dragResetTimer);
  dragResetTimer = setTimeout(() => {
    dragPanelOffset = null;
    dragResetTimer = null;
  }, 200);
});

let pendingActivateTimer = null;

function cancelPendingActivate() {
  if (pendingActivateTimer) {
    clearTimeout(pendingActivateTimer);
    pendingActivateTimer = null;
  }
}

ipcMain.on('bubble-toggle-chat', () => {
  cancelPendingActivate();
  toggleChatPanel();
});

ipcMain.on('bubble-hide', () => {
  cancelPendingActivate();
  applySettings({ bubbleEnabled: false });
});

ipcMain.on('chat-panel-open-main', () => {
  showMainWindow();
});

ipcMain.on('main-header-open-compact', () => {
  showChatPanel();
});

ipcMain.on('bubble-context-menu', (e) => {
  cancelPendingActivate();
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Quick Chat', click: () => showChatPanel() },
    { label: 'Open Full Messenger', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Hide Bubble', click: () => toggleBubble() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
  menu.popup({ window: win });
});

function getSettings() {
  return {
    bubbleEnabled: store.get('bubbleEnabled', true),
  };
}

function notifySettingsChanged() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings-update', getSettings());
  }
}

function applySettings(next) {
  if (typeof next.bubbleEnabled === 'boolean') {
    store.set('bubbleEnabled', next.bubbleEnabled);
    if (!next.bubbleEnabled) {
      destroyBubbleWindow();
    }
  }
  updateBubbleVisibility();
  notifySettingsChanged();
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 420,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Preferences',
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile('settings.html');

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

ipcMain.on('viewer-save-copy', (e) => {
  const info = viewerFiles.get(e.sender.id);
  if (!info) return;
  try {
    const dest = uniqueDownloadPath(info.filename);
    fs.copyFileSync(info.filePath, dest);
    shell.showItemInFolder(dest);
  } catch (err) {
    console.error('Saving attachment copy failed:', err);
  }
});

ipcMain.on('viewer-open-external', (e) => {
  const info = viewerFiles.get(e.sender.id);
  if (!info) return;
  shell.openPath(info.filePath).then((err) => {
    if (err) console.error('Opening attachment externally failed:', err);
  });
});

ipcMain.handle('settings-get', () => getSettings());

ipcMain.on('settings-set', (_e, next) => {
  applySettings(next || {});
});

function createMenu() {
  const template = [
    {
      label: 'Messenger',
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates...',
          click: () => checkForUpdates(true),
        },
        { type: 'separator' },
        {
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettingsWindow(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (mainWindow) mainWindow.hide();
          },
        },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Toggle Floating Bubble',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => toggleBubble(),
        },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Auto-updater setup
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

let updateDownloadStarted = false;
let updateDownloaded = false;
let updateDownloadedInfo = null;
let manualCheckInFlight = false;
let updateDownloadProgress = 0;

function setUpdateProgressBar(fraction) {
  for (const win of [mainWindow, chatPanelWindow]) {
    if (win && !win.isDestroyed()) win.setProgressBar(fraction);
  }
}

async function promptRestartForUpdate(info) {
  const version = info && info.version ? `v${info.version}` : 'The update';
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: `${version} is ready to install. Restart Messenger to apply it?`,
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    performUpdateRestart();
  }
}

function performUpdateRestart() {
  isQuitting = true;

  // Force-close every window we own so quitAndInstall has nothing to wait on
  // and the new instance doesn't launch alongside a lingering old process.
  for (const win of [bubbleWindow, chatPanelWindow, settingsWindow, mainWindow]) {
    if (win && !win.isDestroyed()) {
      win.removeAllListeners('close');
      win.destroy();
    }
  }
  bubbleWindow = null;
  chatPanelWindow = null;
  settingsWindow = null;
  mainWindow = null;

  setTimeout(() => autoUpdater.quitAndInstall(), 150);
}

function checkForUpdates(manual = false) {
  if (updateDownloaded) {
    if (manual) promptRestartForUpdate(updateDownloadedInfo);
    return;
  }
  if (updateDownloadStarted) {
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Downloading Update',
        message: `Update is downloading… ${Math.round(updateDownloadProgress)}%`,
        detail: 'We’ll let you know when it’s ready to install.',
        buttons: ['OK'],
      });
    }
    return;
  }
  manualCheckInFlight = manual;
  autoUpdater.checkForUpdates().catch((err) => {
    manualCheckInFlight = false;
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Update Check Failed',
        message: err && err.message ? err.message : String(err),
        buttons: ['OK'],
      });
    } else {
      console.error('Update check failed:', err);
    }
  });
}

autoUpdater.on('update-available', async (info) => {
  if (updateDownloadStarted || updateDownloaded) return;
  manualCheckInFlight = false;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Available',
    message: `A new version (v${info.version}) is available. Would you like to download it now?`,
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    updateDownloadStarted = true;
    updateDownloadProgress = 0;
    setUpdateProgressBar(0);
    autoUpdater.downloadUpdate().catch((err) => {
      updateDownloadStarted = false;
      setUpdateProgressBar(-1);
      console.error('Update download failed:', err);
    });
  }
});

autoUpdater.on('download-progress', (p) => {
  updateDownloadProgress = p && typeof p.percent === 'number' ? p.percent : 0;
  setUpdateProgressBar(updateDownloadProgress / 100);
});

autoUpdater.on('update-not-available', () => {
  if (manualCheckInFlight) {
    manualCheckInFlight = false;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Up to Date',
      message: 'Messenger is up to date.',
      buttons: ['OK'],
    });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  updateDownloadStarted = false;
  updateDownloaded = true;
  updateDownloadedInfo = info;
  updateDownloadProgress = 100;
  setUpdateProgressBar(-1);
  promptRestartForUpdate(info);
});

autoUpdater.on('error', (err) => {
  const wasManual = manualCheckInFlight;
  manualCheckInFlight = false;
  updateDownloadStarted = false;
  setUpdateProgressBar(-1);
  if (wasManual) {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Update Error',
      message: err && err.message ? err.message : String(err),
      buttons: ['OK'],
    });
  } else {
    console.error('Auto-updater error:', err);
  }
});

// App lifecycle
app.setName('Messenger');

app.on('before-quit', () => {
  isQuitting = true;
});

let pendingBubbleShowTimer = null;

function cancelPendingBubbleShow() {
  if (pendingBubbleShowTimer) {
    clearTimeout(pendingBubbleShowTimer);
    pendingBubbleShowTimer = null;
  }
}

function isBubbleEvent(window) {
  return window && bubbleWindow && window === bubbleWindow;
}

app.on('browser-window-focus', (_event, window) => {
  if (isBubbleEvent(window)) return;
  cancelPendingBubbleShow();
  updateBubbleVisibility();
});

app.on('browser-window-blur', (_event, window) => {
  if (isBubbleEvent(window)) return;
  cancelPendingBubbleShow();
  pendingBubbleShowTimer = setTimeout(() => {
    pendingBubbleShowTimer = null;
    updateBubbleVisibility();
  }, 200);
});

// Single-instance lock. On macOS this app never truly quits when its window is
// closed — it stays alive hidden in the background. Without this lock, clicking
// the Dock/app icon to "reopen" launches a SECOND process, leaving two Dock
// icons (both with the running dot). If we don't get the lock, another instance
// already owns it: quit immediately and let the existing one come forward.
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // A second launch was attempted — surface the existing instance instead.
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    await migrateSession();
    setupDownloads(session.fromPartition('persist:messenger'));
    createMenu();
    createWindow();

    updateBubbleVisibility();

    // Check for updates after 3s delay
    setTimeout(() => checkForUpdates(), 3000);
  });
}

// macOS: show/unminimize window on dock icon click.
// Clicking the bubble also fires `activate`; defer the main-window pop so a
// bubble IPC arriving moments later can cancel it.
app.on('activate', () => {
  cancelPendingActivate();
  pendingActivateTimer = setTimeout(() => {
    pendingActivateTimer = null;
    if (mainWindow === null) {
      createWindow();
    } else {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  }, 120);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
