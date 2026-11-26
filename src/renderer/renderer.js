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
  if (rec && rec.runeOpponent) {
    matchup.appendChild(document.createTextNode('Build shown vs '));
    if (s.opponentIcon) {
      const img = document.createElement('img');
      img.src = s.opponentIcon;
      img.className = 'enemy-icon';
      img.alt = '';
      img.onerror = () => img.remove();
      matchup.appendChild(img);
    }
    matchup.appendChild(document.createTextNode(rec.runeOpponent));
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
    (it.starting || []).slice(0, 2).forEach((n) => itemEl.appendChild(chip(n)));
    (it.boots || []).forEach((n) => itemEl.appendChild(chip(n)));
    (it.core || []).forEach((n) => itemEl.appendChild(chip(n, true)));
  }
}

function renderDataLine(s) {
  const el = $('data-line');
  const d = s.dataInfo;
  if (!d) { el.textContent = ''; return; }
  const when = d.updatedAt ? new Date(d.updatedAt).toLocaleDateString() : 'unknown';
  const patch = d.patch ? `patch ${d.patch}` : 'patch n/a';
  let liveHtml;
  if (d.live === true) liveHtml = '<span class="live">● Live from site</span>';
  else if (d.live === false) liveHtml = '<span class="stale">● Offline — using local snapshot</span>';
  else liveHtml = d.remote ? 'Live site configured' : 'Local data';
  el.innerHTML = `${liveHtml} · ${patch} · local snapshot ${when}`;
}

function setButtonsEnabled(s) {
  const ready = s.connected && s.champion && s.champion.name && s.recommendation;
  const inChampSelect = s.phase === 'ChampSelect';
  ['btn-runes', 'btn-items', 'btn-all'].forEach((id) => ($(id).disabled = !ready));
  // Summoner spells can only be set during champ select.
  $('btn-spells').disabled = !ready || !inChampSelect;
}

let opponentFocused = false;

function render(s) {
  renderStatus(s);
  renderChampion(s);
  renderDataLine(s);
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

window.addEventListener('DOMContentLoaded', async () => {
  window.companion.onState(render);
  render(await window.companion.getState());

  const oppInput = $('opponent-input');
  oppInput.addEventListener('focus', () => (opponentFocused = true));
  oppInput.addEventListener('blur', () => (opponentFocused = false));
  let t = null;
  oppInput.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => window.companion.setOpponent(oppInput.value), 400);
  });

  $('auto-import').addEventListener('change', (e) => window.companion.setAutoImport(e.target.checked));
  $('flash-right').addEventListener('change', (e) => window.companion.setFlashSide(e.target.checked));
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
