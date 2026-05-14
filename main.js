const { app, BrowserWindow, shell, Menu, dialog, session, ipcMain, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const path = require('path');

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

function isMessengerUrl(url) {
  return (
    url.startsWith('https://www.facebook.com/messages') ||
    url.startsWith('https://facebook.com/messages') ||
    url.startsWith('https://www.messenger.com/')
  );
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

  // Handle new window requests (target="_blank" links)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isMessengerUrl(url)) {
      shell.openExternal(url);
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

    if (!shouldAllowNavigation(url)) {
      event.preventDefault();
      shell.openExternal(url);
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

  mainWindow.on('show', () => syncDockVisibility());
  mainWindow.on('hide', () => syncDockVisibility());

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
    focusable: false,
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

  chatPanelWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isMessengerUrl(url)) shell.openExternal(url);
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
    if (!shouldAllowNavigation(url)) {
      event.preventDefault();
      shell.openExternal(url);
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
    syncDockVisibility();
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
    syncDockVisibility();
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
  syncDockVisibility();
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
    syncDockVisibility();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  syncDockVisibility();
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

ipcMain.on('bubble-toggle-chat', () => {
  toggleChatPanel();
});

ipcMain.on('bubble-hide', () => {
  applySettings({ bubbleEnabled: false });
});

ipcMain.on('chat-panel-open-main', () => {
  showMainWindow();
});

ipcMain.on('bubble-context-menu', (e) => {
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
    hideDockWithBubble: store.get('hideDockWithBubble', false),
  };
}

function syncDockVisibility() {
  if (process.platform !== 'darwin' || !app.dock) return;
  const hideDock = store.get('hideDockWithBubble', false);
  const bubbleVisible = !!(
    bubbleWindow &&
    !bubbleWindow.isDestroyed() &&
    bubbleWindow.isVisible()
  );
  const mainVisible = !!(
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.isVisible()
  );
  const chatVisible = !!(
    chatPanelWindow &&
    !chatPanelWindow.isDestroyed() &&
    chatPanelWindow.isVisible()
  );
  const shouldHide = hideDock && bubbleVisible && !mainVisible && !chatVisible;
  const currentlyHidden = !app.dock.isVisible();
  if (shouldHide === currentlyHidden) return;
  if (shouldHide) app.dock.hide();
  else app.dock.show();
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
  if (typeof next.hideDockWithBubble === 'boolean') {
    store.set('hideDockWithBubble', next.hideDockWithBubble);
  }
  updateBubbleVisibility();
  syncDockVisibility();
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
          click: () => checkForUpdates(),
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

function checkForUpdates() {
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Update check failed:', err);
  });
}

autoUpdater.on('update-available', async (info) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Available',
    message: `A new version (v${info.version}) is available. Would you like to download and install it?`,
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });

  if (response === 0) {
    autoUpdater.downloadUpdate();
  }
});

autoUpdater.on('update-downloaded', async () => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Complete',
    message: 'Update downloaded. The app will now restart to install it.',
    buttons: ['Restart'],
  });

  if (response === 0) {
    autoUpdater.quitAndInstall();
  }
});

autoUpdater.on('error', (err) => {
  console.error('Auto-updater error:', err);
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

app.whenReady().then(async () => {
  await migrateSession();
  createMenu();
  createWindow();

  updateBubbleVisibility();
  syncDockVisibility();

  // Check for updates after 3s delay
  setTimeout(() => checkForUpdates(), 3000);
});

// macOS: show/unminimize window on dock icon click
app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
