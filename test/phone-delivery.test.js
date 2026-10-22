'use strict';
// Phones sleep, switch Wi-Fi and get their tabs frozen. These tests make sure nothing sent
// from the computer is lost along the way.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');
const { SnapNode } = require('../src/core/node');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snapdrop-phone-'));
let node;

before(async () => {
  node = new SnapNode({ id: 'desk0001', name: 'Mac', downloadDir: path.join(tmp, 'dl'), port: 0, heartbeatMs: 300 });
  await node.start();
});
after(async () => {
  await node.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A fake phone. autoAck mimics the real client; returns received messages. */
function phone(cid, { port = node.port, since = 0, epoch = '', autoAck = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${node.webToken}&cid=${cid}&name=iPhone&since=${since}&epoch=${epoch}`);
  const got = [];
  ws.got = got;
  ws.ready = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'hello') { ws.hello = m; resolve(m); return; }
      if (m.type === 'pong') return;
      got.push(m);
      if (autoAck) ws.send(JSON.stringify({ type: 'ack', seq: m.seq }));
    });
  });
  ws.on('error', () => {});
  return ws;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('awake phone: text is delivered and confirmed', async () => {
  const p = phone('awake');
  const hello = await p.ready;
  const r = await node.sendText(hello.id, 'hi phone');
  assert.equal(r.delivered, true);
  assert.equal(p.got[0].text, 'hi phone');
  p.close();
});

test('sleeping phone: sender is told it is queued, phone gets it when it wakes up', async () => {
  // Relay that silently stops forwarding — what a frozen iOS tab looks like to the computer.
  let frozen = false;
  const relay = net.createServer((c) => {
    const s = net.connect(node.port, '127.0.0.1');
    c.on('data', (d) => !frozen && s.write(d));
    s.on('data', (d) => !frozen && c.write(d));
    c.on('error', () => {}); s.on('error', () => {});
    c.on('close', () => s.destroy()); s.on('close', () => c.destroy());
  }).listen(0);
  await new Promise((r) => relay.on('listening', r));

  const p = phone('sleepy', { port: relay.address().port });
  const hello = await p.ready;
  frozen = true;

  const r = await node.sendText(hello.id, 'sent while asleep');
  assert.equal(r.delivered, false, 'must not claim delivery');
  assert.equal(p.got.length, 0);

  await wait(900); // heartbeat notices the dead socket
  const listed = node.listPeers().find((x) => x.id === hello.id);
  assert.equal(listed.online, false, 'phone shown as asleep');
  assert.equal(listed.pending, 1);

  await node.sendText(hello.id, 'sent while offline');
  p.terminate();
  relay.close();

  const back = phone('sleepy', { since: 0, epoch: hello.epoch });
  await back.ready;
  await wait(150);
  assert.deepEqual(back.got.map((m) => m.text), ['sent while asleep', 'sent while offline']);
  assert.equal(node.listPeers().find((x) => x.id === hello.id).pending, 0);
  back.close();
});

test('reconnect with "since" does not repeat what the phone already has', async () => {
  const p = phone('resume');
  const hello = await p.ready;
  await node.sendText(hello.id, 'one');
  await node.sendText(hello.id, 'two');
  const lastSeq = p.got.at(-1).seq;
  p.close();
  await wait(50);
  await node.sendText(hello.id, 'three');

  const again = phone('resume', { since: lastSeq, epoch: hello.epoch });
  await again.ready;
  await wait(150);
  assert.deepEqual(again.got.map((m) => m.text), ['three']);
  again.close();
});

test('two sockets from one phone both stay connected (no kick-each-other loop)', async () => {
  const a = phone('twotabs');
  const hello = await a.ready;
  const closed = [];
  a.on('close', (c) => closed.push(c));
  const b = phone('twotabs');
  await b.ready;
  await wait(200);
  assert.deepEqual(closed, []);
  const r = await node.sendText(hello.id, 'to both');
  assert.equal(r.delivered, true);
  assert.equal(a.got.at(-1).text, 'to both');
  assert.equal(b.got.at(-1).text, 'to both');
  a.close(); b.close();
});

test('after a computer restart (new epoch) the phone gets the new messages from the start', async () => {
  const p = phone('restart', { since: 999, epoch: 'old-epoch' });
  const hello = await p.ready;
  assert.notEqual(hello.epoch, 'old-epoch');
  const r = await node.sendText(hello.id, 'fresh');
  assert.equal(r.delivered, true);
  assert.equal(p.got[0].text, 'fresh');
  p.close();
});

test('files to a sleeping phone are queued too and the link still works later', async () => {
  const p = phone('files', { autoAck: false });
  const hello = await p.ready;
  p.terminate();
  await wait(50);
  const f = path.join(tmp, 'doc.pdf');
  fs.writeFileSync(f, 'pdf');
  const r = await node.sendFiles(hello.id, [f]);
  assert.equal(r.delivered, false);

  const back = phone('files', { epoch: hello.epoch });
  await back.ready;
  await wait(150);
  const msg = back.got.find((m) => m.type === 'file');
  assert.ok(msg);
  const dl = await fetch(`http://127.0.0.1:${node.port}${msg.url}`);
  assert.equal(await dl.text(), 'pdf');
  back.close();
});

test('phone can send while its socket is reconnecting (iOS photo picker case)', async () => {
  for (const [url, body] of [['/api/upload', 'photo'], ['/api/text', JSON.stringify({ text: 'hi' })]]) {
    const r = await fetch(`http://127.0.0.1:${node.port}${url}`, {
      method: 'POST', body,
      headers: { 'x-snap-token': node.webToken, 'x-snap-cid': 'picker1', 'x-snap-name': 'iPhone', 'x-snap-filename': 'IMG_1.JPG' },
    });
    assert.equal(r.status, 200, url);
  }
  const listed = node.listPeers().find((p) => p.id === 'web-picker1');
  assert.ok(listed, 'phone shows up even before its socket reconnects');
  assert.equal(listed.name, 'iPhone');
});

test('request with no phone id at all still works', async () => {
  const r = await fetch(`http://127.0.0.1:${node.port}/api/text`, {
    method: 'POST', body: JSON.stringify({ text: 'old client' }), headers: { 'x-snap-token': node.webToken },
  });
  assert.equal(r.status, 200);
});

test('a save failure on the computer is reported as such, not as a network error', async () => {
  const bad = new SnapNode({ id: 'desk0002', name: 'Mac', downloadDir: path.join(tmp, 'dl2'), port: 0 });
  await bad.start();
  bad.downloadDir = path.join(tmp, 'missing', 'nested'); // like a folder the app may not write to
  let reported = null;
  bad.on('save-error', (e) => { reported = e; });
  const r = await fetch(`http://127.0.0.1:${bad.port}/api/upload`, {
    method: 'POST', body: 'x', headers: { 'x-snap-token': bad.webToken, 'x-snap-cid': 'c', 'x-snap-filename': 'a.jpg' },
  });
  assert.equal(r.status, 507);
  assert.equal((await r.json()).error, 'save-failed');
  assert.equal(reported.code, 'ENOENT');
  await bad.stop();
});
