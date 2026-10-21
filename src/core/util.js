'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function randomId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Non-internal IPv4 addresses, private LAN ranges first. */
function lanAddresses() {
  const out = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      out.push({ ifname, address: a.address });
    }
  }
  const score = (ip) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  return out.sort((a, b) => score(a.address) - score(b.address)).map((a) => a.address);
}

/** Strip path components and characters that are illegal on Windows/macOS. */
function safeFileName(name) {
  let base = String(name || 'file').split(/[\\/]/).pop();
  base = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  if (!base) base = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = '_' + base;
  return base.slice(0, 200);
}

/** "photo.jpg" -> "photo (1).jpg" if taken. */
function uniquePath(dir, name) {
  const safe = safeFileName(name);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 1; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

function platformLabel(p = process.platform) {
  return { darwin: 'mac', win32: 'windows', linux: 'linux' }[p] || p;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = { randomId, lanAddresses, safeFileName, uniquePath, platformLabel, safeEqual };
