'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { LcuClient } = require('./lcu');
const ddragon = require('./ddragon');
const importer = require('./importer');

const POLL_MS = 2000;

const lcu = new LcuClient();
let win = null;

const state = {
  connected: false,
  phase: 'None',
  summoner: null, // { displayName, summonerId }
  champion: null, // { id, name }
  opponent: null, // name string (auto-detected or user-set)
  manualOpponent: null, // user override
  recommendation: null, // { runeDisplay, itemDisplay, runeOpponent }
  autoImport: false,
  lastImport: null, // { ok, runes, items, error, at }
  error: null,
};

let lastChampKey = null; // de-dupe recommendation fetches / auto-imports

function push() {
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
}

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 640,
    resizable: true,
    title: 'LoL Companion',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', push);
}

// Pull the local player's champion + best-guess lane opponent out of a champ
// select session.
async function readChampSelect(session) {
  const myTeam = session.myTeam || [];
  const theirTeam = session.theirTeam || [];
  const me = myTeam.find((c) => c.cellId === session.localPlayerCellId);
  if (!me) return { champion: null, opponent: null };

  const champId = me.championId || me.championPickIntent || 0;
  const champion = champId ? { id: champId, name: await ddragon.championName(champId) } : null;

  // Lane opponent: enemy in the same assigned position (only if revealed).
  let opponent = null;
  if (me.assignedPosition) {
    const foe = theirTeam.find((c) => c.assignedPosition === me.assignedPosition && c.championId);
    if (foe) opponent = await ddragon.championName(foe.championId);
  }
  return { champion, opponent };
}

async function refreshRecommendation() {
  state.recommendation = null;
  state.error = null;
  if (!state.champion || !state.champion.name) return;
  const opp = state.manualOpponent || state.opponent || '';
  try {
    const runes = await importer.buildRunePage(state.champion.name, opp);
    const items = await importer.buildItemSet(state.champion.name, state.champion.id, opp);
    let spellDisplay = [];
    try {
      spellDisplay = (await importer.buildSummonerSpells(state.champion.name, opp)).display;
    } catch {
      /* spells optional for preview */
    }
    state.recommendation = {
      runeOpponent: runes.meta.opponent,
      runeDisplay: runes.display,
      itemDisplay: items.display,
      spellDisplay,
    };
  } catch (e) {
    state.error = String(e.message || e);
  }
}

async function doImport(what) {
  if (!state.champion || !state.champion.name) return { ok: false, error: 'No champion selected' };
  if (!state.summoner) return { ok: false, error: 'Summoner not loaded' };
  const opp = state.manualOpponent || state.opponent || '';
  const all = what === 'all' || what === 'both';
  const result = { ok: true, runes: false, spells: false, items: false, error: null, at: Date.now() };
  try {
    if (what === 'runes' || all) {
      const { page } = await importer.buildRunePage(state.champion.name, opp);
      await importer.applyRunePage(lcu, page);
      result.runes = true;
    }
    if (what === 'spells' || all) {
      // Summoner spells can only be set during champ select.
      if (state.phase === 'ChampSelect') {
        const { selection } = await importer.buildSummonerSpells(state.champion.name, opp);
        await importer.applySummonerSpells(lcu, selection);
        result.spells = true;
      } else if (what === 'spells') {
        throw new Error('Summoner spells can only be set during champ select');
      }
    }
    if (what === 'items' || all) {
      const { itemSet } = await importer.buildItemSet(state.champion.name, state.champion.id, opp);
      await importer.applyItemSet(lcu, state.summoner.summonerId, itemSet);
      result.items = true;
    }
  } catch (e) {
    result.ok = false;
    result.error = String(e.message || e);
  }
  state.lastImport = result;
  push();
  return result;
}

async function tick() {
  try {
    if (!lcu.isConnected()) {
      await lcu.connect();
      state.connected = lcu.isConnected();
      if (!state.connected) {
        state.phase = 'ClientNotFound';
        state.summoner = null;
        push();
        return;
      }
    }

    // Load summoner once per connection.
    if (!state.summoner) {
      try {
        const s = await lcu.currentSummoner();
        if (s && s.summonerId) state.summoner = { displayName: s.displayName || s.gameName, summonerId: s.summonerId };
      } catch {
        /* client up but not logged in yet */
      }
    }

    const phase = await lcu.gameflowPhase();
    state.phase = (phase || 'None').replace(/"/g, '');

    if (state.phase === 'ChampSelect') {
      const session = await lcu.champSelectSession();
      const { champion, opponent } = await readChampSelect(session);
      state.champion = champion;
      state.opponent = opponent;

      const key = champion ? `${champion.id}:${state.manualOpponent || opponent || ''}` : null;
      if (key && key !== lastChampKey) {
        lastChampKey = key;
        await refreshRecommendation();
        if (state.autoImport && state.recommendation) await doImport('both');
      }
    } else {
      state.champion = null;
      state.opponent = null;
      state.recommendation = null;
      lastChampKey = null;
    }
    state.error = state.error || null;
    push();
  } catch (e) {
    // A dropped connection (client closed) resets us to discovery mode.
    lcu.disconnect();
    state.connected = false;
    state.summoner = null;
    state.phase = 'ClientNotFound';
    push();
  }
}

function startLoop() {
  tick();
  setInterval(tick, POLL_MS);
}

// ---- IPC ----
ipcMain.handle('get-state', () => state);
ipcMain.handle('set-opponent', async (_e, name) => {
  state.manualOpponent = name && name.trim() ? name.trim() : null;
  lastChampKey = null; // force refresh with new opponent
  await refreshRecommendation();
  push();
  return state.recommendation;
});
ipcMain.handle('set-auto-import', (_e, on) => {
  state.autoImport = !!on;
  push();
  return state.autoImport;
});
ipcMain.handle('import', (_e, what) => doImport(what || 'both'));

// Read-only health check: proves the live client link works without changing
// anything — connects, reads the summoner name, phase, and current page count.
ipcMain.handle('test-connection', async () => {
  try {
    if (!lcu.isConnected()) await lcu.connect();
    if (!lcu.isConnected()) {
      return { ok: false, error: 'League client not found. Make sure League is running and you are logged in.' };
    }
    const summoner = await lcu.currentSummoner();
    const phase = (await lcu.gameflowPhase()) || 'None';
    const pages = (await lcu.get('/lol-perks/v1/pages')) || [];
    const name = summoner && (summoner.displayName || summoner.gameName);
    if (!name) return { ok: false, error: 'Client found but no summoner logged in yet.' };
    return { ok: true, summoner: name, phase: String(phase).replace(/"/g, ''), pageCount: pages.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

app.whenReady().then(() => {
  createWindow();
  startLoop();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
