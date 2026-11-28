'use strict';

const $ = (id) => document.getElementById(id);

const PHASE_LABEL = {
  ClientNotFound: 'League client not found — open the client',
  None: 'In client',
  Lobby: 'In lobby',
  Matchmaking: 'In queue',
  ReadyCheck: 'Match found',
  ChampSelect: 'Champ select',
  InProgress: 'In game',
  EndOfGame: 'Post game',
};

// obj can be a string, or { name, icon }. prefix is optional leading text.
function chip(obj, key, prefix) {
  const el = document.createElement('span');
  el.className = 'chip' + (key ? ' key' : '');
  const o = typeof obj === 'string' ? { name: obj } : obj || {};
  if (o.icon) {
    const img = document.createElement('img');
    img.src = o.icon;
    img.alt = '';
    img.onerror = () => img.remove();
    el.appendChild(img);
  }
  el.appendChild(document.createTextNode((prefix || '') + (o.name || '')));
  return el;
}

function renderStatus(s) {
  const dot = $('dot');
  const text = $('status-text');
  dot.className = 'dot';
  if (!s.connected) {
    dot.classList.add('bad');
    text.textContent = 'Client not connected';
  } else if (s.phase === 'ChampSelect') {
    dot.classList.add('busy');
    text.textContent = (PHASE_LABEL[s.phase] || s.phase) + (s.summoner ? ` · ${s.summoner.displayName}` : '');
  } else {
    dot.classList.add('ok');
    text.textContent = PHASE_LABEL[s.phase] || s.phase;
  }
}

function renderChampion(s) {
  const empty = $('champ-empty');
  const active = $('champ-active');
  if (!s.champion || !s.champion.name) {
    empty.classList.remove('hidden');
    active.classList.add('hidden');
    $('phase-line').textContent = s.connected ? '' : 'Start League of Legends to connect.';
    return;
  }
  empty.classList.add('hidden');
  active.classList.remove('hidden');

  $('champ-name').textContent = s.champion.name;
  const champIcon = $('champ-icon');
  if (s.champion.icon) {
    champIcon.src = s.champion.icon;
    champIcon.style.display = '';
  } else {
    champIcon.style.display = 'none';
  }

  const rec = s.recommendation;
  $('position-pill').textContent = rec && rec.itemDisplay && rec.itemDisplay.position ? rec.itemDisplay.position : '';

  const matchup = $('matchup-line');
  matchup.innerHTML = '';
  if (rec && rec.scope === 'matchup' && rec.runeOpponent) {
    matchup.appendChild(document.createTextNode('Matchup vs '));
    if (s.opponentIcon) {
      const img = document.createElement('img');
      img.src = s.opponentIcon;
      img.className = 'enemy-icon';
      img.alt = '';
      img.onerror = () => img.remove();
      matchup.appendChild(img);
    }
    matchup.appendChild(document.createTextNode(rec.runeOpponent));
  } else if (rec) {
    matchup.appendChild(document.createTextNode('Overall build (all matchups)'));
  }

  const runeEl = $('rune-rec');
  const spellEl = $('spell-rec');
  const itemEl = $('item-rec');
  runeEl.innerHTML = '';
  spellEl.innerHTML = '';
  itemEl.innerHTML = '';

  const err = $('rec-error');
  if (s.error) {
    err.textContent = s.error;
    err.classList.remove('hidden');
  } else {
    err.classList.add('hidden');
  }

  if (rec && rec.runeDisplay) {
    const r = rec.runeDisplay;
    if (r.keystone) runeEl.appendChild(chip(r.keystone, true));
    if (r.primaryStyle) runeEl.appendChild(chip(r.primaryStyle));
    if (r.secondaryStyle) runeEl.appendChild(chip(r.secondaryStyle, false, '+ '));
  }
  if (rec && rec.spellDisplay) {
    rec.spellDisplay.forEach((sp) => spellEl.appendChild(chip(sp, true)));
  }
  if (rec && rec.itemDisplay) {
    const it = rec.itemDisplay;
    (it.starting || []).slice(0, 4).forEach((n) => itemEl.appendChild(chip(n)));
    (it.early || []).forEach((n) => itemEl.appendChild(chip(n)));
    (it.core || []).forEach((n) => itemEl.appendChild(chip(n, true)));
    (it.boots || []).forEach((n) => itemEl.appendChild(chip(n)));
  }
  renderPaths(rec && rec.itemDisplay);
}

// Build paths: each is a coherent build keyed by the first item; picking one
// changes the previewed/imported build.
function renderPaths(it) {
  const el = $('path-rec');
  el.innerHTML = '';
  if (!it || !it.paths || it.paths.length < 2) return;
  it.paths.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'path' + (p.id === it.selectedPathId ? ' on' : '');
    btn.title = p.description || '';
    if (p.icon) {
      const img = document.createElement('img');
      img.src = p.icon;
      img.alt = '';
      img.onerror = () => img.remove();
      btn.appendChild(img);
    }
    const text = document.createElement('span');
    const wr = p.winRate != null ? ` · ${Math.round(p.winRate)}% WR` : '';
    text.textContent = `${p.label} — ${Math.round(p.pct)}%${wr}${p.lowSample ? ' (small sample)' : ''}`;
    btn.appendChild(text);
    if (p.badge) {
      const b = document.createElement('em');
      b.textContent = p.badge;
      btn.appendChild(b);
    }
    btn.addEventListener('click', () => window.companion.setBuildPath(p.id));
    el.appendChild(btn);
  });
}

function renderDataLine(s) {
  const el = $('data-line');
  const d = s.dataInfo;
  if (!d) { el.textContent = ''; return; }
  if (d.live === false) {
    // Offline: data comes from the local snapshot, so show its patch + date.
    const when = d.snapshotDate ? new Date(d.snapshotDate).toLocaleDateString() : 'unknown';
    const p = d.snapshotPatch ? `patch ${d.snapshotPatch}` : '';
    el.innerHTML = `<span class="stale">● Offline</span> · using local snapshot ${p} · ${when}`.replace(/ ·  ·/g, ' ·');
  } else {
    // Live (or configured): show the current public patch from the site.
    const p = d.patch ? `patch ${d.patch}` : '';
    const label = d.live === true ? '<span class="live">● Live from site</span>' : 'Live from site';
    el.innerHTML = `${label}${p ? ' · ' + p : ''}`;
  }
}

function setButtonsEnabled(s) {
  const ready = s.connected && s.champion && s.champion.name && s.recommendation;
  const inChampSelect = s.phase === 'ChampSelect';
  ['btn-runes', 'btn-items', 'btn-all'].forEach((id) => ($(id).disabled = !ready));
  // Summoner spells can only be set during champ select.
  $('btn-spells').disabled = !ready || !inChampSelect;
}

let opponentFocused = false;

function renderUpdateBanner(s) {
  const banner = $('update-banner');
  const text = $('update-text');
  const btn = $('btn-restart-update');
  const u = s.appUpdate;
  if (!u || u.status === 'idle' || u.status === 'checking' || u.status === 'error') {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  if (u.status === 'downloading') {
    text.textContent = `Downloading update${u.version ? ` ${u.version}` : ''}… ${u.percent || 0}%`;
    btn.classList.add('hidden');
  } else if (u.status === 'ready') {
    text.textContent = `Update ${u.version || ''} ready.`;
    btn.classList.remove('hidden');
  }
}

function render(s) {
  renderStatus(s);
  renderChampion(s);
  renderDataLine(s);
  renderUpdateBanner(s);
  setButtonsEnabled(s);

  // Reflect an in-progress data update.
  const upBtn = $('btn-update');
  const upBox = $('update-result');
  if (s.updating) {
    upBtn.disabled = true;
    const { done, total, champion } = s.updating;
    upBox.textContent = total ? `Updating ${done}/${total}${champion ? ` (${champion})` : ''}…` : 'Starting update…';
    upBox.className = 'import-result';
  } else {
    upBtn.disabled = false;
  }

  const oppInput = $('opponent-input');
  if (!opponentFocused) {
    oppInput.value = s.manualOpponent || '';
    oppInput.placeholder = s.opponent ? `auto: ${s.opponent}` : 'auto-detected — e.g. Thresh';
  }
  $('auto-import').checked = !!s.autoImport;
  $('flash-right').checked = s.flashOnRight !== false;
  if (document.activeElement !== $('role-select')) $('role-select').value = s.role || '';
  const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support' };
  const SOURCE_LABEL = {
    assigned: 'assigned',
    lobby: 'lobby pick',
    smite: 'has Smite',
    team: 'guessed from team',
  };
  const autoOpt = $('role-select').querySelector('option[value=""]');
  autoOpt.textContent = s.detectedPosition
    ? `Auto-detect (${ROLE_LABEL[s.detectedPosition]} · ${SOURCE_LABEL[s.positionSource] || 'detected'})`
    : s.positionSource === 'mode'
      ? 'Auto-detect (no lanes in this mode)'
      : 'Auto-detect';

  if (s.lastImport) {
    const r = s.lastImport;
    const box = $('import-result');
    if (r.ok) {
      const parts = [];
      if (r.runes) parts.push('runes');
      if (r.spells) parts.push('spells');
      if (r.items) parts.push('build');
      box.textContent = parts.length ? `Imported ${parts.join(' + ')} ✓` : '';
      box.className = 'import-result ok';
    } else {
      box.textContent = `Import failed: ${r.error}`;
      box.className = 'import-result bad';
    }
  }
}

async function importNow(what) {
  const box = $('import-result');
  box.textContent = 'Importing…';
  box.className = 'import-result';
  await window.companion.importNow(what);
}

let champions = []; // [{ name, icon }]

function setupOpponentAutocomplete() {
  const input = $('opponent-input');
  const list = $('opponent-list');
  let t = null;
  let activeIdx = -1;

  window.companion.getChampions().then((c) => (champions = c || []));

  const commit = (val) => {
    clearTimeout(t);
    t = setTimeout(() => window.companion.setOpponent(val), 300);
  };

  const hide = () => { list.classList.add('hidden'); list.innerHTML = ''; activeIdx = -1; };

  const renderList = () => {
    const q = input.value.trim().toLowerCase();
    const matches = (q
      ? champions.filter((c) => c.name.toLowerCase().includes(q))
      : champions
    ).slice(0, 8);
    list.innerHTML = '';
    if (!matches.length) { hide(); return; }
    matches.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'ac-item' + (i === activeIdx ? ' active' : '');
      const img = document.createElement('img');
      img.src = c.icon; img.alt = ''; img.onerror = () => img.remove();
      row.appendChild(img);
      row.appendChild(document.createTextNode(c.name));
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep focus/selection before blur
        input.value = c.name;
        commit(c.name);
        hide();
      });
      list.appendChild(row);
    });
    list.classList.remove('hidden');
  };

  input.addEventListener('focus', () => { opponentFocused = true; renderList(); });
  input.addEventListener('blur', () => { opponentFocused = false; setTimeout(hide, 150); });
  input.addEventListener('input', () => { activeIdx = -1; renderList(); commit(input.value); });
  input.addEventListener('keydown', (e) => {
    const items = Array.from(list.querySelectorAll('.ac-item'));
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); renderList(); }
    else if (e.key === 'Enter' && activeIdx >= 0 && items[activeIdx]) {
      e.preventDefault();
      const name = items[activeIdx].textContent;
      input.value = name; commit(name); hide();
    } else if (e.key === 'Escape') { hide(); }
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  window.companion.onState(render);
  render(await window.companion.getState());

  setupOpponentAutocomplete();

  $('auto-import').addEventListener('change', (e) => window.companion.setAutoImport(e.target.checked));
  $('flash-right').addEventListener('change', (e) => window.companion.setFlashSide(e.target.checked));
  $('role-select').addEventListener('change', (e) => window.companion.setRole(e.target.value));
  $('btn-restart-update').addEventListener('click', () => window.companion.restartToUpdate());
  $('btn-runes').addEventListener('click', () => importNow('runes'));
  $('btn-spells').addEventListener('click', () => importNow('spells'));
  $('btn-items').addEventListener('click', () => importNow('items'));
  $('btn-all').addEventListener('click', () => importNow('all'));

  $('btn-test').addEventListener('click', async () => {
    const box = $('test-result');
    box.textContent = 'Testing…';
    box.className = 'import-result';
    const r = await window.companion.testConnection();
    if (r.ok) {
      box.textContent = `Connected ✓  ${r.summoner} · ${r.phase} · ${r.pageCount} rune pages`;
      box.className = 'import-result ok';
    } else {
      box.textContent = r.error;
      box.className = 'import-result bad';
    }
  });

  $('btn-update').addEventListener('click', async () => {
    const box = $('update-result');
    box.textContent = 'Starting update…';
    box.className = 'import-result';
    const r = await window.companion.updateData();
    if (r.ok) {
      const m = r.manifest || {};
      box.textContent = `Updated ✓  ${m.champions || ''} champions · patch ${m.patch || 'n/a'}`;
      box.className = 'import-result ok';
    } else {
      box.textContent = `Update failed: ${r.error}`;
      box.className = 'import-result bad';
    }
  });
});
