'use strict';
/**
 * SnapDrop Desk — Electron main process.
 * Tray / menu-bar app: global hotkey opens a mini drop window, files dropped on a device tile
 * fly to that device, and the text clipboard can be mirrored between paired desktops.
 */
const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain,
  clipboard, Notification, dialog, shell, screen,
} = require('electron');
const QRCode = require('qrcode');
const { SnapNode } = require('../core/node');
const { Discovery } = require('../core/discovery');
const { ClipboardSync } = require('../core/clipboard-sync');
const { lanAddresses } = require('../core/util');
const { Settings } = require('./settings');
const integration = require('./integration');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const isMac = process.platform === 'darwin';
// Lets you run two copies on one machine for testing: SNAPDROP_USER_DATA=/tmp/b npm start
if (process.env.SNAPDROP_USER_DATA) app.setPath('userData', process.env.SNAPDROP_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit(); // the running instance receives our argv via 'second-instance'
} else {
  let settings, node, discovery, clipSync, tray, win;
  let pending = []; // files waiting for the user to pick a device (context menu, dock drop)
  let pinned = !!process.env.SNAPDROP_SMOKE;
  let quitting = false;

  /* ---------------------------------------------------------------- boot */
  app.whenReady().then(async () => {
    if (isMac) app.dock.hide();
    settings = new Settings(app.getPath('userData'), app.getPath('downloads'));

    node = new SnapNode({
      id: settings.get('id'),
      name: settings.get('name'),
      port: settings.get('port'),
      downloadDir: settings.get('downloadDir'),
      webToken: settings.get('webToken'),
      trust: settings.get('trust'),
      approve: askToAccept,
      acceptClipboard: () => settings.get('clipboardSync'),
    });
    await node.start();
    wireNode();

    discovery = new Discovery({ id: node.id, name: node.name, platform: node.platform, port: node.port });
    discovery.on('up', (p) => node.upsertPeer(p));
    discovery.on('down', (id) => { if (!node.peers.get(id)?.manual) node.removePeer(id); });
    discovery.on('error', (e) => console.warn('[mdns]', e.message));
    discovery.start();

    clipSync = new ClipboardSync({
      read: () => clipboard.readText(),
      write: (t) => clipboard.writeText(t),
      onLocalChange: broadcastClipboard,
    });
    if (settings.get('clipboardSync')) clipSync.start();

    createWindow();
    createTray();
    registerHotkey();
    queueFiles(filesFromArgv(process.argv));

    // CI smoke test: `SNAPDROP_SMOKE=out.png electron .` boots, screenshots the window, quits.
    if (process.env.SNAPDROP_SMOKE) {
      win.webContents.once('did-finish-load', () => {
        showWindow('cursor');
        setTimeout(async () => {
          if (process.env.SNAPDROP_SMOKE_VIEW) await win.webContents.executeJavaScript(`switchView(${JSON.stringify(process.env.SNAPDROP_SMOKE_VIEW)})`);
          await new Promise((r) => setTimeout(r, 400));
          fs.writeFileSync(process.env.SNAPDROP_SMOKE, (await win.webContents.capturePage()).toPNG());
          console.log('SMOKE OK', JSON.stringify(node.listPeers().map((p) => p.name)));
          app.quit();
        }, Number(process.env.SNAPDROP_SMOKE_DELAY || 2500));
      });
    }
  });

  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv);
    if (files.length) queueFiles(files);
    else showWindow();
  });
  app.on('open-file', (e, file) => { // macOS: dropped on app icon / "Open With"
    e.preventDefault();
    if (app.isReady()) queueFiles([file]);
    else process.argv.push(file);
  });
  app.on('window-all-closed', (e) => e.preventDefault()); // live in the tray
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', async () => {
    globalShortcut.unregisterAll();
    clipSync?.stop();
    await discovery?.stop();
    await node?.stop();
  });

  /* ---------------------------------------------------------------- core events */
  function wireNode() {
    const pushPeers = () => send('peers', node.listPeers());
    node.on('peer-up', pushPeers);
    node.on('peer-down', pushPeers);
    node.on('peer-update', pushPeers);
    node.on('trust-changed', (trust) => { settings.set('trust', trust); pushPeers(); });

    let lastProgress = 0;
    node.on('progress', (p) => {
      const now = Date.now();
      if (p.sent !== p.total && now - lastProgress < 80) return;
      lastProgress = now;
      send('progress', p);
      win?.setProgressBar(p.sent === p.total ? -1 : p.sent / (p.total || 1));
    });

    node.on('file-received', ({ path: file, name, from }) => {
      notify(`${name}`, `From ${from.name} — click to show`, () => shell.showItemInFolder(file));
      send('toast', `Received ${name} from ${from.name}`);
    });

    node.on('text-received', ({ text, kind, from }) => {
      if (kind === 'clipboard') {
        clipSync.applyRemote(text);
        return;
      }
      if (settings.get('copyIncomingText')) clipSync.applyRemote(text) || clipboard.writeText(text);
      const short = text.length > 90 ? text.slice(0, 90) + '…' : text;
      notify(`Text from ${from.name}`, `${short}\nCopied to clipboard`, () => {
        if (/^https?:\/\/\S+$/.test(text.trim())) shell.openExternal(text.trim());
      });
    });
  }

  function broadcastClipboard(text) {
    for (const p of node.listPeers()) {
      if (p.kind === 'desktop' && p.trusted) node.sendText(p.id, text, 'clipboard').catch(() => {});
    }
  }

  /** Incoming transfer from a device we have not paired with yet. */
  async function askToAccept({ peer, kind, name, size, preview }) {
    const what = kind === 'file' ? `${name} (${formatSize(size)})` : `text: “${(preview || '').slice(0, 80)}”`;
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'SnapDrop Desk',
      message: `${peer.name} wants to send you ${what}`,
      detail: `${peer.platform} · ${peer.host}\n“Always allow” pairs the two computers: future transfers skip this question and clipboard sync becomes possible.`,
      buttons: ['Accept', 'Always allow', 'Decline'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return ['accept', 'always', 'deny'][response];
  }

  /* ---------------------------------------------------------------- window */
  function createWindow() {
    win = new BrowserWindow({
      width: 380,
      height: 540,
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      transparent: isMac,
      vibrancy: isMac ? 'popover' : undefined,
      backgroundColor: isMac ? '#00000000' : '#f4f1ea',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true },
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'drop.html'));
    win.on('blur', () => { if (!pinned && !win.webContents.isDevToolsOpened()) win.hide(); });
    win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
    if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  }

  /** Show near the cursor (hotkey) or under the tray icon (click). */
  function showWindow(anchor = 'cursor') {
    if (!win) return;
    const [w, h] = win.getSize();
    let x, y;
    if (anchor === 'tray' && tray) {
      const b = tray.getBounds();
      const wa = screen.getDisplayMatching(b).workArea;
      x = Math.round(b.x + b.width / 2 - w / 2);
      y = b.y < wa.y + wa.height / 2 ? b.y + b.height + 6 : b.y - h - 6;
      x = Math.min(Math.max(x, wa.x + 6), wa.x + wa.width - w - 6);
    } else {
      const c = screen.getCursorScreenPoint();
      const wa = screen.getDisplayNearestPoint(c).workArea;
      x = Math.min(Math.max(c.x - w / 2, wa.x + 6), wa.x + wa.width - w - 6);
      y = Math.min(Math.max(c.y - 60, wa.y + 6), wa.y + wa.height - h - 6);
    }
    win.setPosition(Math.round(x), Math.round(y));
    win.show();
    win.focus();
    sendState();
  }

  function toggleWindow(anchor) {
    if (win?.isVisible()) win.hide();
    else showWindow(anchor);
  }

  function send(channel, data) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  }

  async function stateSnapshot() {
    const url = node.webUrl();
    return {
      me: node.info(),
      peers: node.listPeers(),
      pending,
      addresses: lanAddresses(),
      phoneUrl: url,
      qr: await QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#1b1a17', light: '#ffffff' } }),
      settings: {
        name: settings.get('name'),
        hotkey: settings.get('hotkey'),
        clipboardSync: settings.get('clipboardSync'),
        downloadDir: settings.get('downloadDir'),
        sendTo: integration.isInstalled(),
        launchAtLogin: app.getLoginItemSettings().openAtLogin,
      },
      platform: process.platform,
    };
  }
  const sendState = async () => send('state', await stateSnapshot());

  function queueFiles(files) {
    files = files.filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    if (!files.length) return;
    pending = [...new Set([...pending, ...files])];
    send('pending', pending);
    showWindow();
  }

  /* ---------------------------------------------------------------- tray */
  function createTray() {
    const img = nativeImage.createFromPath(path.join(ASSETS, isMac ? 'trayTemplate.png' : 'tray.png'));
    if (isMac) img.setTemplateImage(true);
    tray = new Tray(img);
    tray.setToolTip('SnapDrop Desk');
    tray.on('click', () => toggleWindow('tray'));
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
    tray.on('drop-files', (_e, files) => queueFiles(files)); // macOS: drop straight onto the menu-bar icon
    if (!isMac) tray.setContextMenu(buildMenu());
    const refresh = () => { if (!isMac) tray.setContextMenu(buildMenu()); };
    node.on('peer-up', refresh);
    node.on('peer-down', refresh);
  }

  function buildMenu() {
    const peers = node.listPeers();
    return Menu.buildFromTemplate([
      { label: `Open drop window   ${accelLabel(settings.get('hotkey'))}`, click: () => showWindow('tray') },
      { type: 'separator' },
      { label: peers.length ? 'Nearby devices' : 'No devices found yet', enabled: false },
      ...peers.map((p) => ({ label: `   ${p.name}${p.trusted ? '  ✓' : ''}`, enabled: false })),
      { type: 'separator' },
      {
        label: 'Sync clipboard with paired computers', type: 'checkbox', checked: settings.get('clipboardSync'),
        click: (i) => setClipboardSync(i.checked),
      },
      { label: 'Connect phone (QR code)…', click: () => { showWindow('tray'); send('toast', 'qr'); } },
      { label: 'Open received files', click: () => shell.openPath(settings.get('downloadDir')) },
      { type: 'separator' },
      ...integration.menuItems(() => sendState()),
      {
        label: 'Launch at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
        click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, openAsHidden: true }),
      },
      { type: 'separator' },
      { label: 'Quit SnapDrop Desk', role: 'quit' },
    ]);
  }

  function setClipboardSync(on) {
    settings.set('clipboardSync', on);
    on ? clipSync.start() : clipSync.stop();
    sendState();
  }

  function registerHotkey(accel = settings.get('hotkey')) {
    globalShortcut.unregisterAll();
    const ok = globalShortcut.register(accel, () => toggleWindow('cursor'));
    if (!ok) console.warn(`Hotkey ${accel} is taken by another app`);
    return ok;
  }

  /* ---------------------------------------------------------------- IPC */
  ipcMain.handle('state', () => stateSnapshot());

  ipcMain.handle('send-files', async (_e, peerId, paths) => {
    pinned = true; // keep the window up while the transfer runs
    try {
      const r = await node.sendFiles(peerId, paths);
      pending = pending.filter((p) => !paths.includes(p));
      send('pending', pending);
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      pinned = false;
    }
  });

  ipcMain.handle('send-text', async (_e, peerId, text) => {
    try { return { ok: true, ...(await node.sendText(peerId, text, 'message')) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('add-manual', async (_e, address) => {
    const [host, port] = String(address).trim().split(':');
    try { return { ok: true, peer: await node.addManualPeer(host, Number(port) || undefined) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('set-setting', async (_e, key, value) => {
    switch (key) {
      case 'name':
        value = String(value).trim().slice(0, 40) || settings.get('name');
        settings.set('name', value);
        node.name = value;
        discovery.rename(value);
        break;
      case 'clipboardSync': setClipboardSync(!!value); break;
      case 'hotkey':
        if (!registerHotkey(value)) { registerHotkey(); return { ok: false, error: 'That shortcut is taken' }; }
        settings.set('hotkey', value);
        break;
      case 'sendTo': value ? integration.install() : integration.uninstall(); break;
      case 'launchAtLogin': app.setLoginItemSettings({ openAtLogin: !!value, openAsHidden: true }); break;
      case 'downloadDir': {
        const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.get('downloadDir') });
        if (r.canceled) return { ok: false };
        settings.set('downloadDir', r.filePaths[0]);
        node.downloadDir = r.filePaths[0];
        break;
      }
      default: return { ok: false, error: 'unknown setting' };
    }
    sendState();
    return { ok: true };
  });

  ipcMain.handle('untrust', (_e, id) => { node.untrust(id); return { ok: true }; });
  ipcMain.handle('reset-phone-link', () => { settings.set('webToken', node.resetWebToken()); sendState(); });
  ipcMain.handle('open-downloads', () => shell.openPath(settings.get('downloadDir')));
  ipcMain.handle('clear-pending', () => { pending = []; send('pending', pending); });
  ipcMain.handle('hide', () => win.hide());
  ipcMain.handle('pin', (_e, v) => { pinned = !!v; });

  /* ---------------------------------------------------------------- helpers */
  function notify(title, body, onClick) {
    if (!settings.get('notifications') || !Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    if (onClick) n.on('click', onClick);
    n.show();
  }

  function filesFromArgv(argv) {
    // Packaged: [exe, ...files]; dev: [electron, ., ...files]. Also accept "--send <file>".
    return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && a !== '.' && path.isAbsolute(a) && fs.existsSync(a));
  }
}

function accelLabel(a) {
  return process.platform === 'darwin'
    ? a.replace('CommandOrControl', '⌘').replace('Shift', '⇧').replace('Alt', '⌥').replace(/\+/g, '')
    : a.replace('CommandOrControl', 'Ctrl');
}

function formatSize(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
