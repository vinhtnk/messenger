const { app, BrowserWindow, shell, Menu, dialog, session } = require('electron');
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

function isMessengerUrl(url) {
  return (
    url.startsWith('https://www.facebook.com/messages') ||
    url.startsWith('https://facebook.com/messages') ||
    url.startsWith('https://www.messenger.com/')
  );
}

let mainWindow;
let isQuitting = false;

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
            href.startsWith('https://www.messenger.com/')) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        window.open(href, '_blank');
      }, true);
    `);
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

app.whenReady().then(async () => {
  await migrateSession();
  createMenu();
  createWindow();

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

app.on('before-quit', () => {
  isQuitting = true;
});
