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

function chip(text, key) {
  const el = document.createElement('span');
  el.className = 'chip' + (key ? ' key' : '');
  el.textContent = text;
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
  const rec = s.recommendation;
  $('position-pill').textContent = rec && rec.itemDisplay && rec.itemDisplay.position ? rec.itemDisplay.position : '';
  $('matchup-line').textContent = rec && rec.runeOpponent ? `Build shown vs ${rec.runeOpponent}` : '';

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
    if (r.secondaryStyle) runeEl.appendChild(chip('+ ' + r.secondaryStyle));
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
  setButtonsEnabled(s);

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
});
