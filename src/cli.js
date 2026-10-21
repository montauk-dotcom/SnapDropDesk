#!/usr/bin/env node
'use strict';
/**
 * Headless SnapDrop node — no Electron needed. Handy for a Linux box, a Raspberry Pi,
 * or quickly trying the protocol.
 *
 *   node src/cli.js                         receive: shows a QR for phones, asks before accepting
 *   node src/cli.js --yes                   receive and auto-accept everything (trusted LAN only!)
 *   node src/cli.js send <file...> --to <name-or-ip[:port]>
 *   node src/cli.js text "hello" --to <name-or-ip[:port]>
 *
 * Options: --name <device name>  --dir <download folder>  --port <port>
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const QRCode = require('qrcode');
const { SnapNode } = require('./core/node');
const { Discovery } = require('./core/discovery');
const { randomId } = require('./core/util');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
};

const stateFile = path.join(os.homedir(), '.snapdrop-cli.json');
let saved = {};
try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
saved.id ||= randomId(8);
saved.trust ||= { incoming: {}, outgoing: {} };
const persist = () => fs.writeFileSync(stateFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
persist();

const yes = flag('yes');
const name = opt('name', saved.name || `${os.hostname().replace(/\.local$/, '')} (cli)`);
const dir = opt('dir', path.join(os.homedir(), 'Downloads', 'SnapDrop'));
const port = Number(opt('port', 47321));
const to = opt('to');
const [cmd, ...rest] = argv;

const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
});

const fmt = (n) => (n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function main() {
  const node = new SnapNode({
    id: saved.id, name, port: cmd ? 0 : port, downloadDir: dir, trust: saved.trust,
    approve: async ({ peer, kind, name: file, size, preview }) => {
      if (yes) return 'accept';
      const what = kind === 'file' ? `${file} (${fmt(size)})` : `text "${preview}"`;
      const a = await ask(`\n${peer.name} (${peer.host}) wants to send ${what}. [y]es / [a]lways / [n]o: `);
      return a.startsWith('a') ? 'always' : a.startsWith('y') ? 'accept' : 'deny';
    },
  });
  node.on('trust-changed', (t) => { saved.trust = t; persist(); });
  await node.start();

  const discovery = new Discovery({ id: node.id, name: node.name, platform: node.platform, port: node.port });
  discovery.on('up', (p) => node.upsertPeer(p));
  discovery.on('down', (id) => node.removePeer(id));
  discovery.on('error', () => {});
  discovery.start();

  if (!cmd) {
    const url = node.webUrl();
    console.log(`\nSnapDrop node "${name}" listening on port ${node.port}`);
    console.log(`Saving to ${dir}\n\nScan with your phone:\n`);
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
    console.log(url, '\n');
    node.on('peer-up', (p) => console.log(`+ ${p.name} (${p.platform})`));
    node.on('peer-down', (p) => console.log(`- ${p.name}`));
    node.on('file-received', (f) => console.log(`↓ ${f.name}  ${fmt(f.size)}  from ${f.from.name}  → ${f.path}`));
    node.on('text-received', (t) => console.log(`✉ ${t.from.name}: ${t.text}`));
    const shutdown = async () => { await discovery.stop(); await node.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (!to) throw new Error('Use --to <device name or IP>');
  let peer;
  if (/^[\d.]+(:\d+)?$/.test(to)) {
    const [host, p] = to.split(':');
    peer = await node.addManualPeer(host, Number(p) || 47321);
  } else {
    process.stdout.write(`Looking for "${to}"…`);
    const deadline = Date.now() + 8000;
    while (!peer && Date.now() < deadline) {
      peer = node.listPeers().find((p) => p.name.toLowerCase().includes(to.toLowerCase()));
      if (!peer) await new Promise((r) => setTimeout(r, 300));
    }
    console.log(peer ? ` found ${peer.name}` : ' not found');
    if (!peer) throw new Error('Device not found — try its IP instead');
  }

  node.on('progress', (p) => process.stdout.write(`\r↑ ${p.name}  ${Math.round((p.sent / (p.total || 1)) * 100)}%   `));
  if (cmd === 'send') {
    const r = await node.sendFiles(peer.id, rest.map((f) => path.resolve(f)));
    console.log(`\nSent ${r.sent} file(s) to ${peer.name}`);
  } else if (cmd === 'text') {
    await node.sendText(peer.id, rest.join(' '));
    console.log(`Text sent to ${peer.name}`);
  } else {
    throw new Error(`Unknown command ${cmd}`);
  }
  await discovery.stop();
  await node.stop();
}

main().catch((e) => { console.error(`\n✖ ${e.message}`); process.exit(1); });
