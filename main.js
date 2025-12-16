const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

let mainWindow;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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

  mainWindow.loadURL('https://www.messenger.com');

  // Handle external links - open in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('https://www.messenger.com') && !url.startsWith('https://messenger.com')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Handle navigation to external sites
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('https://www.messenger.com') && !url.startsWith('https://messenger.com') && !url.startsWith('https://www.facebook.com')) {
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

  // Check for updates when window is shown
  mainWindow.on('show', () => {
    autoUpdater.checkForUpdatesAndNotify();
  });
}

// Create application menu
function createMenu() {
  const template = [
    {
      label: 'Messenger',
      submenu: [
        { role: 'about' },
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

app.whenReady().then(() => {
  createMenu();
  createWindow();

  // Check for updates
  autoUpdater.checkForUpdatesAndNotify();

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    } else {
      mainWindow.show();
    }
    // Check for updates when app comes to foreground
    autoUpdater.checkForUpdatesAndNotify();
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

// Auto-updater
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Update Available',
    message: 'A new version is available. Downloading now...',
  });
});

autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Update Ready',
    message: 'A new version has been downloaded. Restart the app to apply the update.',
    buttons: ['Restart', 'Later']
  }).then((result) => {
    if (result.response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
    }
  });
});

autoUpdater.on('error', (err) => {
  console.log('Auto-updater error:', err);
});
