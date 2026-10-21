'use strict';
/**
 * "Send with SnapDrop" in the OS file manager.
 *   Windows: shortcut in the Explorer “Send to” menu (right-click → Send to → SnapDrop Desk).
 *   Linux:   .desktop entry so it shows up in “Open With” for any file.
 *   macOS:   no install needed — drop files on the menu-bar icon or the app icon, or use
 *            Finder → Open With → SnapDrop Desk.
 * Either way the OS launches the app with file paths; the single-instance lock forwards them
 * to the running app, which opens the device picker.
 */
const { app, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const launch = () => {
  // In dev, `electron .` needs the app folder as first argument.
  const args = app.isPackaged ? '' : `"${path.resolve(__dirname, '..', '..')}"`;
  return { exe: process.execPath, args };
};

const target = () => {
  if (process.platform === 'win32') return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'SnapDrop Desk.lnk');
  if (process.platform === 'linux') return path.join(os.homedir(), '.local', 'share', 'applications', 'snapdrop-desk-send.desktop');
  return null;
};

function isInstalled() {
  const t = target();
  return !!t && fs.existsSync(t);
}

function install() {
  const t = target();
  if (!t) return false;
  const { exe, args } = launch();
  fs.mkdirSync(path.dirname(t), { recursive: true });
  if (process.platform === 'win32') {
    return shell.writeShortcutLink(t, 'create', { target: exe, args, description: 'Send with SnapDrop Desk', icon: exe, iconIndex: 0 });
  }
  fs.writeFileSync(t, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Send with SnapDrop',
    `Exec="${exe}" ${args} %F`,
    'Icon=snapdrop-desk',
    'MimeType=application/octet-stream;image/*;video/*;audio/*;text/*;application/pdf;application/zip;',
    'NoDisplay=true',
    'Terminal=false',
    '',
  ].join('\n'));
  return true;
}

function uninstall() {
  const t = target();
  if (t) fs.rmSync(t, { force: true });
}

function menuItems(onChange) {
  if (process.platform === 'darwin') return [];
  return [{
    label: process.platform === 'win32' ? 'Add to Explorer “Send to” menu' : 'Add to “Open With” menu',
    type: 'checkbox',
    checked: isInstalled(),
    click: (item) => { item.checked ? install() : uninstall(); onChange?.(); },
  }];
}

module.exports = { isInstalled, install, uninstall, menuItems };
