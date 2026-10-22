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
  clipboard, Notification, dialog, shell, screen, nativeTheme,
} = require('electron');
const QRCode = require('qrcode');
const { SnapNode } = require('../core/node');
const { Discovery } = require('../core/discovery');
const { ClipboardSync } = require('../core/clipboard-sync');
const { lanAddresses } = require('../core/util');
const { Settings } = require('./settings');
const integration = require('./integration');
const { isStatusItemHidden } = require('./notch');

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
    settings = new Settings(app.getPath('userData'), app.getPath('downloads'));
    applyDock();
    nativeTheme.themeSource = settings.get('theme');

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
    node.setAppearance({ theme: settings.get('theme'), accent: settings.get('accent') });
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
    if (isMac) {
      setTimeout(checkTrayVisible, 2000); // macOS needs a moment to lay out the menu bar
      setInterval(checkTrayVisible, 60 * 1000).unref?.(); // other apps starting can push us out
      screen.on('display-metrics-changed', () => setTimeout(checkTrayVisible, 1000));
    }
    registerHotkey();
    queueFiles(filesFromArgv(process.argv));

    // First launch: there is no Dock icon, so open the window once to show where the app lives.
    if (!settings.get('welcomed') && !process.env.SNAPDROP_SMOKE) {
      settings.set('welcomed', true);
      win.webContents.once('did-finish-load', () => {
        showWindow('tray');
        send('toast', isMac ? 'SnapDrop Desk lives in the menu bar — look for “SDD”' : 'SnapDrop Desk lives in the tray');
      });
    }

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

  // macOS: opening the app again from Finder / Launchpad / Spotlight while it runs → show it.
  app.on('activate', () => { if (win) showWindow(trayVisibleSafe() ? 'tray' : 'cursor'); });
  const trayVisibleSafe = () => { try { return !!tray && !trayHidden(); } catch { return false; } };

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
      const done = p.sent >= p.total;
      win?.setProgressBar(done ? -1 : p.sent / (p.total || 1));
      setTrayTitle(done ? null : `${Math.round((p.sent / (p.total || 1)) * 100)}%`);
    });

    node.on('file-received', ({ path: file, name, from }) => {
      notify(`${name}`, `From ${from.name} — click to show`, () => shell.showItemInFolder(file));
      send('toast', `Received ${name} from ${from.name}`);
    });

    let saveErrorShown = 0;
    node.on('save-error', async ({ dir, code }) => {
      if (Date.now() - saveErrorShown < 60000) return; // one dialog per burst
      saveErrorShown = Date.now();
      const perm = code === 'EACCES' || code === 'EPERM';
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'SnapDrop Desk',
        message: perm ? 'SnapDrop Desk is not allowed to save files here' : 'Could not save the received file',
        detail: perm && isMac
          ? `${dir}\n\nAllow access in System Settings → Privacy & Security → Files and Folders → SnapDrop Desk, or choose another folder.`
          : `${dir}\n(${code}) Choose another folder for received files.`,
        buttons: [perm && isMac ? 'Open System Settings' : 'OK', 'Choose another folder', 'Cancel'],
        cancelId: 2,
        noLink: true,
      });
      if (response === 0 && perm && isMac) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders');
      if (response === 1) {
        const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
        if (!r.canceled) { settings.set('downloadDir', r.filePaths[0]); node.downloadDir = r.filePaths[0]; sendState(); }
      }
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
      backgroundColor: isMac ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#12110f' : '#f4f1ea'),
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
    if (anchor === 'tray' && trayVisibleSafe()) { // hidden icon: open near the mouse instead
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
    if (isMac) app.focus({ steal: true }); // menu-bar apps are never "active" on their own
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
        menuBarTitle: settings.get('menuBarTitle'),
        theme: settings.get('theme'),
        accent: settings.get('accent'),
        showInDock: settings.get('showInDock'),
      },
      platform: process.platform,
    };
  }
  const sendState = async () => { refreshTray(); send('state', await stateSnapshot()); };

  function queueFiles(files) {
    files = files.filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    if (!files.length) return;
    pending = [...new Set([...pending, ...files])];
    send('pending', pending);
    showWindow();
  }

  /* ---------------------------------------------------------------- tray */
  function createTray() {
    let img = nativeImage.createFromPath(path.join(ASSETS, isMac ? 'trayTemplate.png' : 'tray.png'));
    if (img.isEmpty()) img = nativeImage.createEmpty(); // the “SDD” title alone still shows on macOS
    if (isMac) img.setTemplateImage(true);
    tray = new Tray(img);
    tray.setToolTip('SnapDrop Desk');
    setTrayTitle();
    tray.on('drop-files', (_e, files) => queueFiles(files)); // macOS: drop straight onto the menu-bar icon
    if (!isMac) tray.on('click', () => toggleWindow('tray')); // Windows / Linux: click opens the window
    // macOS: like most menu-bar apps (AmneziaVPN etc.) a click on “SDD” opens this menu.
    // Windows / Linux: the same menu on right-click.
    tray.setContextMenu(buildMenu());
    node.on('peer-up', refreshTray);
    node.on('peer-down', refreshTray);
  }

  function refreshTray() {
    if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
    if (isMac && (settings.get('showInDock') || dockFallback)) app.dock.setMenu(buildMenu());
  }

  function buildMenu() {
    const peers = node.listPeers();
    return Menu.buildFromTemplate([
      {
        label: 'Open SnapDrop Desk', accelerator: settings.get('hotkey'), registerAccelerator: false,
        click: () => showWindow('tray'),
      },
      { label: 'Send files…', click: pickAndQueueFiles },
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
      ...(isMac ? [{
        label: 'Show in Dock', type: 'checkbox', checked: settings.get('showInDock'),
        click: (i) => { settings.set('showInDock', i.checked); applyDock(); sendState(); },
      }] : []),
      { type: 'separator' },
      ...integration.menuItems(() => sendState()),
      {
        label: 'Launch at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
        click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, openAsHidden: true }),
      },
      { type: 'separator' },
      { label: 'Settings…', click: () => { showWindow('tray'); send('toast', 'settings'); } },
      { label: 'Quit SnapDrop Desk', accelerator: 'CommandOrControl+Q', registerAccelerator: false, click: () => app.quit() },
    ]);
  }

  /** macOS menu bar: “SDD” next to the icon (or transfer progress while sending). */
  function setTrayTitle(extra = null) {
    if (!isMac || !tray) return;
    const label = settings.get('menuBarTitle') || '';
    const text = [label, extra].filter(Boolean).join(' ');
    tray.setTitle(text ? ` ${text}` : '', { fontType: 'monospacedDigit' });
  }

  /** macOS: Dock icon is optional (useful when a crowded menu bar / notch hides the icon). */
  let dockFallback = false; // Dock icon shown because the menu-bar item is hidden

  function applyDock() {
    if (!isMac) return;
    if (settings.get('showInDock') || dockFallback) {
      app.dock.show();
      app.dock.setMenu(buildMenu()); // right-click the Dock icon: same menu, incl. Quit
    } else {
      app.dock.hide();
    }
  }

  /**
   * macOS hides menu-bar items that don't fit right of the camera notch, without telling the
   * app. Newest items go leftmost, so a freshly installed app is the first to disappear.
   * On a notched screen no status item can sit left of the notch, so if ours is there (or has
   * no size) it is hidden: fall back to a Dock icon so the user can still reach the app.
   */
  function trayHidden() {
    const b = tray.getBounds();
    const d = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    return isStatusItemHidden(b, d);
  }

  let hiddenWarned = false;
  function checkTrayVisible() {
    if (!isMac || !tray || tray.isDestroyed()) return;
    let hidden = false;
    try { hidden = trayHidden(); } catch { return; }
    if (!hidden) return;
    console.warn('[tray] menu-bar item looks hidden (notch / full menu bar) — showing Dock icon');
    if (!dockFallback) { dockFallback = true; applyDock(); }
    if (hiddenWarned) return;
    hiddenWarned = true;
    const ru = app.getLocale().startsWith('ru');
    dialog.showMessageBox({
      type: 'info',
      title: 'SnapDrop Desk',
      message: ru ? 'Значку SDD не хватило места в верхней панели' : 'The SDD icon does not fit in the menu bar',
      detail: ru
        ? 'macOS прячет значки, которые не помещаются справа от выреза камеры. Пока что SnapDrop Desk есть в Доке: клик открывает окно, правый клик — меню и «Quit».\n\nЧтобы вернуть SDD наверх: зажми ⌘ и перетащи пару ненужных значков вниз из панели (или закрой их приложения), затем перезапусти SnapDrop Desk.'
        : 'macOS hides menu-bar icons that don’t fit to the right of the camera notch. For now SnapDrop Desk is in the Dock: click opens the window, right-click shows the menu and Quit.\n\nTo get SDD back: hold ⌘ and drag a few icons you don’t need out of the menu bar (or quit their apps), then restart SnapDrop Desk.',
      buttons: ['OK'],
      noLink: true,
    }).then(() => showWindow('cursor'));
  }

  async function pickAndQueueFiles() {
    const r = await dialog.showOpenDialog({ title: 'Send with SnapDrop', properties: ['openFile', 'multiSelections'] });
    if (!r.canceled) queueFiles(r.filePaths);
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
      case 'menuBarTitle':
        settings.set('menuBarTitle', String(value).trim().slice(0, 12));
        setTrayTitle();
        break;
      case 'theme':
        if (!['system', 'light', 'dark'].includes(value)) return { ok: false, error: 'unknown theme' };
        settings.set('theme', value);
        nativeTheme.themeSource = value;
        node.setAppearance({ theme: value });
        break;
      case 'accent':
        if (!/^#[0-9a-f]{6}$/i.test(String(value))) return { ok: false, error: 'bad colour' };
        settings.set('accent', value);
        node.setAppearance({ accent: value });
        break;
      case 'showInDock':
        settings.set('showInDock', !!value);
        applyDock();
        break;
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
  ipcMain.handle('quit', () => app.quit());
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

function formatSize(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
