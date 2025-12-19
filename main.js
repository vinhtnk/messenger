const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const path = require('path');

const store = new Store();

// URLs
const MESSENGER_URL = 'https://www.messenger.com';
const MESSENGER_URL_ALT = 'https://messenger.com';
const FACEBOOK_LOGIN_URL = 'https://www.facebook.com/login';
const FACEBOOK_CHECKPOINT_URL = 'https://www.facebook.com/checkpoint';
const GITHUB_RELEASES_URL = 'https://github.com/vinhtnk/messenger/releases';

// Helper function to check if URL is allowed in app
function isAllowedUrl(url) {
  return url.startsWith(MESSENGER_URL) ||
         url.startsWith(MESSENGER_URL_ALT) ||
         url.startsWith(FACEBOOK_LOGIN_URL) ||
         url.startsWith(FACEBOOK_CHECKPOINT_URL);
}

function isMessengerUrl(url) {
  return url.startsWith(MESSENGER_URL) || url.startsWith(MESSENGER_URL_ALT);
}

let mainWindow;
let isQuitting = false;

function createWindow() {
  // Get saved window bounds or use defaults
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
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'default',
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

  // Handle external links - open in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isMessengerUrl(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Handle navigation to external sites
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
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

// Create application menu
function createMenu() {
  const template = [
    {
      label: 'Messenger',
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates...',
          click: () => {
            checkForUpdates();
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
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
        { role: 'selectAll' }
      ]
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
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (mainWindow) {
              mainWindow.hide();
            }
          }
        },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Check for updates and show dialog with download link
function checkForUpdates() {
  autoUpdater.checkForUpdates();
}

app.whenReady().then(() => {
  createMenu();
  createWindow();

  // Check for updates on launch only
  checkForUpdates();

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

// Set the app name for macOS
app.setName('Messenger');

// Auto-updater - disable auto download
autoUpdater.autoDownload = false;

autoUpdater.on('update-available', (info) => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Update Available',
    message: `A new version (${info.version}) is available.`,
    buttons: ['Download', 'Later']
  }).then((result) => {
    if (result.response === 0) {
      shell.openExternal(GITHUB_RELEASES_URL);
    }
  });
});

autoUpdater.on('update-not-available', () => {
  // Silent - no dialog when up to date
});

autoUpdater.on('error', (err) => {
  console.log('Auto-updater error:', err);
});
