const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

let win;
let isMini = false;   // tracks whether we are in mini-pill mode

// Height per tab — tuned to fit each panel's content exactly
const TAB_HEIGHTS = {
  timer:    310,
  chrome:   310,
  stats:    360,
  settings: 480,
};

// Mini-pill dimensions
const MINI_W = 320;
const MINI_H = 52;

app.whenReady().then(() => {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 380,
    height: TAB_HEIGHTS.timer,
    x: width - 400,
    y: 20,
    frame: false,
    titleBarStyle: 'hidden',        // macOS: hides native title bar fully
    trafficLightPosition: { x: -100, y: -100 }, // push traffic lights off-screen
    alwaysOnTop: true,
    resizable: false,
    transparent: true,
    hasShadow: false,               // prevents macOS from drawing a shadow around the native frame
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // macOS: must call this BEFORE loadFile for transparent to take effect
  app.dock.hide();                  // hide from dock so it truly floats
  win.setAlwaysOnTop(true, 'floating', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile('index.html');
});

// Drag the window
ipcMain.on('move-window', (event, { dx, dy }) => {
  const [x, y] = win.getPosition();
  win.setPosition(x + dx, y + dy);
});

// Resize window when user switches tabs
ipcMain.on('resize-for-tab', (event, tab) => {
  if (isMini) return;   // don't resize while in mini mode
  const newHeight = TAB_HEIGHTS[tab] || TAB_HEIGHTS.timer;
  const [x, y] = win.getPosition();
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const newX = Math.min(x, sw - 400);
  win.setBounds({ x: newX, y, width: 380, height: newHeight }, true);
});

// Collapse to mini pill when timer starts
ipcMain.on('show-mini', () => {
  isMini = true;
  const [x, y] = win.getPosition();
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const newX = Math.min(x, sw - MINI_W - 20);
  win.setBounds({ x: newX, y, width: MINI_W, height: MINI_H }, true);
});

// Restore to full widget
ipcMain.on('show-full', () => {
  isMini = false;
  const [x, y] = win.getPosition();
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const newX = Math.min(x, sw - 400);
  win.setBounds({ x: newX, y, width: 380, height: TAB_HEIGHTS.timer }, true);
});

ipcMain.on('close-app',    () => app.quit());
ipcMain.on('minimize-app', () => win.minimize());

app.on('window-all-closed', () => app.quit());