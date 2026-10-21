'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { SnapNode } = require('../src/core/node');
const { ClipboardSync } = require('../src/core/clipboard-sync');
const { safeFileName, uniquePath } = require('../src/core/util');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdrop-test-'));
let decisions = [];
let a, b;

before(async () => {
  a = new SnapNode({ id: 'aaaa1111', name: 'Mac', downloadDir: path.join(tmp, 'a'), port: 0 });
  b = new SnapNode({
    id: 'bbbb2222', name: 'Windows PC', downloadDir: path.join(tmp, 'b'), port: 0,
    approve: async () => decisions.shift() || 'deny',
  });
  await a.start();
  await b.start();
  a.upsertPeer({ id: b.id, name: b.name, platform: 'windows', host: '127.0.0.1', port: b.port });
});

after(async () => {
  await a.stop();
  await b.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const once = (em, ev) => new Promise((r) => em.once(ev, r));

test('declined transfer is rejected and nothing is written', async () => {
  decisions = ['deny'];
  const f = path.join(tmp, 'secret.txt');
  fs.writeFileSync(f, 'nope');
  await assert.rejects(a.sendFiles(b.id, [f]), /declined/);
  assert.equal(fs.readdirSync(b.downloadDir).length, 0);
});

test('one-off accepted file arrives intact (1.5 MB, streamed)', async () => {
  decisions = ['accept'];
  const f = path.join(tmp, 'photo.bin');
  const data = crypto.randomBytes(1.5 * 1024 * 1024);
  fs.writeFileSync(f, data);
  const got = once(b, 'file-received');
  await a.sendFiles(b.id, [f]);
  const ev = await got;
  assert.equal(ev.from.id, a.id);
  assert.deepEqual(fs.readFileSync(ev.path), data);
  assert.equal(b.isTrusted(a.id), false);
});

test('"always" pairs devices; later sends need no prompt; files never overwrite', async () => {
  decisions = ['always'];
  const f = path.join(tmp, 'note.txt');
  fs.writeFileSync(f, 'v1');
  await a.sendFiles(b.id, [f]);
  assert.ok(b.isTrusted(a.id));
  assert.ok(a.trust.outgoing[b.id], 'sender learned the key');

  decisions = []; // any prompt would now deny
  await a.sendFiles(b.id, [f]);
  const names = fs.readdirSync(b.downloadDir).sort();
  assert.ok(names.includes('note.txt') && names.includes('note (1).txt'), names.join(','));
});

test('spoofed device id without the key is refused', async () => {
  const evil = new SnapNode({ id: a.id, name: 'Mac', downloadDir: path.join(tmp, 'evil'), port: 0 });
  await evil.start();
  evil.upsertPeer({ id: b.id, name: b.name, host: '127.0.0.1', port: b.port });
  await assert.rejects(evil.sendText(b.id, 'hi'), /bad key/);
  await evil.stop();
});

test('text and clipboard between paired desktops', async () => {
  const got = once(b, 'text-received');
  await a.sendText(b.id, 'Привет 👋', 'message');
  assert.equal((await got).text, 'Привет 👋');

  const clip = once(b, 'text-received');
  await a.sendText(b.id, 'copied on mac', 'clipboard');
  const ev = await clip;
  assert.equal(ev.kind, 'clipboard');
});

test('clipboard from an unpaired device is refused without prompting', async () => {
  const c = new SnapNode({ id: 'cccc3333', name: 'Laptop', downloadDir: path.join(tmp, 'c'), port: 0 });
  await c.start();
  c.upsertPeer({ id: b.id, name: b.name, host: '127.0.0.1', port: b.port });
  decisions = ['always'];
  await assert.rejects(c.sendText(b.id, 'x', 'clipboard'), /pairing/);
  assert.equal(decisions.length, 1, 'approve was not called');
  decisions = [];
  await c.stop();
});

test('phone: web UI served, upload with token, receives pushed file over WebSocket', async () => {
  const page = await fetch(`http://127.0.0.1:${b.port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SnapDrop/);

  const bad = await fetch(`http://127.0.0.1:${b.port}/api/upload`, { method: 'POST', headers: { 'x-snap-token': 'wrong' }, body: 'x' });
  assert.equal(bad.status, 401);

  const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws?t=${b.webToken}&name=iPhone&cid=t1`);
  const hello = JSON.parse(await new Promise((r) => ws.once('message', r)));
  assert.equal(hello.type, 'hello');
  assert.ok(b.listPeers().some((p) => p.id === hello.id && p.kind === 'web'));

  const got = once(b, 'file-received');
  const up = await fetch(`http://127.0.0.1:${b.port}/api/upload`, {
    method: 'POST', body: 'from phone',
    headers: { 'x-snap-token': b.webToken, 'x-snap-web-id': hello.id, 'x-snap-filename': encodeURIComponent('IMG_0001.HEIC') },
  });
  assert.equal(up.status, 200);
  const ev = await got;
  assert.equal(ev.name, 'IMG_0001.HEIC');
  assert.equal(ev.from.name, 'iPhone');

  const f = path.join(tmp, 'for-phone.pdf');
  fs.writeFileSync(f, 'pdf bytes');
  const pushed = new Promise((r) => ws.once('message', (m) => r(JSON.parse(m))));
  await b.sendFiles(hello.id, [f]);
  const msg = await pushed;
  assert.equal(msg.type, 'file');
  const dl = await fetch(`http://127.0.0.1:${b.port}${msg.url}`);
  assert.equal(await dl.text(), 'pdf bytes');
  ws.close();
});

test('path traversal in filenames and static paths is neutralised', async () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('..\\..\\win.ini'), 'win.ini');
  assert.equal(safeFileName('CON.txt'), '_CON.txt');
  const r = await fetch(`http://127.0.0.1:${b.port}/..%2Fpackage.json`);
  assert.equal(r.status, 404);
  assert.match(uniquePath(tmp, 'a/b/c.txt'), /c\.txt$/);
});

test('ClipboardSync broadcasts local changes and never echoes remote text', () => {
  let clip = 'old';
  const sent = [];
  const s = new ClipboardSync({ read: () => clip, write: (t) => (clip = t), onLocalChange: (t) => sent.push(t) });
  s.start();
  s.tick();
  assert.deepEqual(sent, [], 'existing clipboard is not broadcast on start');
  clip = 'hello';
  s.tick();
  assert.deepEqual(sent, ['hello']);
  s.applyRemote('from windows');
  s.tick();
  assert.deepEqual(sent, ['hello'], 'remote text not sent back');
  assert.equal(clip, 'from windows');
  s.stop();
});
