/* Drop window renderer. Talks to the main process only through window.snap (preload). */
'use strict';
const $ = (id) => document.getElementById(id);
const api = window.snap;

let state = null;
let selected = null;
let pinned = false;

const ICONS = {
  laptop: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
  desktop: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
};
const iconFor = (p) => (p.kind === 'web' ? ICONS.phone : p.platform === 'mac' ? ICONS.laptop : ICONS.desktop);
const platformName = (p) => ({ mac: 'Mac', windows: 'Windows', linux: 'Linux', ios: 'iPhone · browser', android: 'Android · browser', web: 'Browser' })[p.platform] || p.platform;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------------------------------------------------------------- render */
function render() {
  if (!state) return;
  document.body.className = state.platform === 'darwin' ? 'mac' : state.platform === 'win32' ? 'win' : 'linux';
  $('me').textContent = `${state.me.name} · ${state.addresses[0] || 'offline'}:${state.me.port}`;
  renderPeers();
  renderPending();

  $('qr').src = state.qr;
  $('url').textContent = state.phoneUrl;

  const s = state.settings;
  if (document.activeElement !== $('sName')) $('sName').value = s.name;
  if (document.activeElement !== $('sHotkey')) $('sHotkey').value = s.hotkey;
  $('sClip').checked = s.clipboardSync;
  $('sSendTo').checked = s.sendTo;
  $('sLogin').checked = s.launchAtLogin;
  $('sDir').textContent = s.downloadDir;
  $('sendToLine').hidden = state.platform === 'darwin';
  $('sendToLabel').textContent = state.platform === 'win32' ? 'Explorer “Send to” menu' : '“Open With” menu';
  $('addr').textContent = `This computer: ${state.addresses.join(', ') || '—'} · port ${state.me.port}`;

  const paired = state.peers.filter((p) => p.trusted);
  $('paired').innerHTML = paired.length ? '' : '<div class="me" style="padding:6px 0">None yet — choose “Always allow” when a transfer arrives.</div>';
  for (const p of paired) {
    const row = document.createElement('div');
    row.className = 'line';
    row.innerHTML = '<span></span><button class="link">Unpair</button>';
    row.firstChild.textContent = p.name;
    row.lastChild.onclick = () => api.untrust(p.id);
    $('paired').appendChild(row);
  }
}

function renderPeers() {
  const grid = $('grid');
  grid.innerHTML = '';
  const peers = state.peers;
  if (selected && !peers.some((p) => p.id === selected)) selected = null;
  if (!selected && peers.length === 1) selected = peers[0].id;

  if (!peers.length) {
    grid.innerHTML = '<div class="empty">Looking for devices on this Wi‑Fi…<br><br>Run SnapDrop Desk on your other computer, or <a id="goPhone">connect a phone</a>.</div>';
    $('goPhone').onclick = () => switchView('phone');
    return;
  }
  for (const p of peers) {
    const t = document.createElement('div');
    t.className = 'tile' + (p.id === selected ? ' sel' : '');
    t.innerHTML = `<div class="ico">${iconFor(p)}</div><div class="nm"></div><div class="sub"></div>${p.trusted ? '<span class="badge">PAIRED</span>' : ''}`;
    t.querySelector('.nm').textContent = p.name;
    t.querySelector('.sub').textContent = platformName(p);
    t.onclick = () => {
      selected = p.id;
      if (state.pending.length) sendFiles(p, state.pending);
      else renderPeers();
    };
    t.addEventListener('dragenter', (e) => { e.preventDefault(); t.classList.add('over'); });
    t.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    t.addEventListener('dragleave', (e) => { if (!t.contains(e.relatedTarget)) t.classList.remove('over'); });
    t.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      t.classList.remove('over');
      const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
      if (paths.length) sendFiles(p, paths);
      else if (e.dataTransfer.getData('text/plain')) sendText(p, e.dataTransfer.getData('text/plain'));
    });
    grid.appendChild(t);
  }
}

function renderPending() {
  const n = state.pending.length;
  $('pending').hidden = !n;
  if (!n) return;
  $('pendingTitle').textContent = `${n} file${n > 1 ? 's' : ''} ready — click a device`;
  $('pendingFiles').textContent = state.pending.map((p) => p.split(/[\\/]/).pop()).join(', ');
}

/* ---------------------------------------------------------------- actions */
async function sendFiles(peer, paths) {
  toast(`Sending to ${peer.name}…`);
  const r = await api.sendFiles(peer.id, paths);
  toast(r.ok ? `Sent ${r.sent} file${r.sent > 1 ? 's' : ''} to ${peer.name}` : r.error);
}

async function sendText(peer, text) {
  const r = await api.sendText(peer.id, text);
  toast(r.ok ? `Text sent to ${peer.name}` : r.error);
  return r.ok;
}

const selectedPeer = () => state?.peers.find((p) => p.id === selected);

$('sendText').onclick = async () => {
  const text = $('text').value;
  const p = selectedPeer();
  if (!text.trim()) return;
  if (!p) return toast('Select a device first');
  if (await sendText(p, text)) $('text').value = '';
};
$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('sendText').click();
});
$('pickFiles').onclick = () => (selectedPeer() ? $('fileInput').click() : toast('Select a device first'));
$('fileInput').onchange = (e) => {
  const paths = [...e.target.files].map((f) => api.pathFor(f)).filter(Boolean);
  e.target.value = '';
  if (paths.length) sendFiles(selectedPeer(), paths);
};

// Dropping anywhere else: send to the selected device, or queue and ask.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
  if (!paths.length) return;
  const p = selectedPeer();
  if (p) sendFiles(p, paths);
  else { state.pending = paths; renderPending(); }
});

$('clearPending').onclick = () => api.clearPending();
$('closeBtn').onclick = () => api.hide();
$('pinBtn').onclick = () => { pinned = !pinned; $('pinBtn').classList.toggle('on', pinned); api.setPinned(pinned); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.hide(); });

function switchView(name) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `v-${name}`));
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));

/* settings */
const saveOnEnter = (el, key) => {
  el.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const r = await api.setSetting(key, el.value);
    toast(r.ok ? 'Saved' : r.error || 'Not saved');
    el.blur();
  });
};
saveOnEnter($('sName'), 'name');
saveOnEnter($('sHotkey'), 'hotkey');
$('sClip').onchange = (e) => api.setSetting('clipboardSync', e.target.checked);
$('sSendTo').onchange = (e) => api.setSetting('sendTo', e.target.checked);
$('sLogin').onchange = (e) => api.setSetting('launchAtLogin', e.target.checked);
$('changeDir').onclick = () => api.setSetting('downloadDir');
$('resetLink').onclick = () => api.resetPhoneLink().then(() => toast('New link — scan again'));
$('manual').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const r = await api.addManual(e.target.value);
  toast(r.ok ? `Added ${r.peer.name}` : r.error);
  if (r.ok) { e.target.value = ''; switchView('devices'); }
});

/* ---------------------------------------------------------------- live updates */
api.on('state', (s) => { state = s; render(); });
api.on('peers', (peers) => { if (state) { state.peers = peers; render(); } });
api.on('pending', (pending) => { if (state) { state.pending = pending; renderPending(); switchView('devices'); } });
api.on('toast', (msg) => (msg === 'qr' ? switchView('phone') : toast(msg)));
api.on('progress', (p) => {
  const done = p.sent >= p.total;
  $('progress').classList.toggle('show', !done);
  $('progName').textContent = `${p.direction === 'out' ? '↑' : '↓'} ${p.name}`;
  $('progPct').textContent = `${Math.round((p.sent / (p.total || 1)) * 100)}%`;
  $('progBar').style.width = `${(p.sent / (p.total || 1)) * 100}%`;
});

api.state().then((s) => { state = s; render(); });
