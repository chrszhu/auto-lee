'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { LcuClient } = require('./lcu');
const ddragon = require('./ddragon');
const importer = require('./importer');
const dataClient = require('./dataClient');
const config = require('./config');

const POLL_MS = 2000;

const lcu = new LcuClient();
let win = null;

const state = {
  connected: false,
  phase: 'None',
  summoner: null, // { displayName, summonerId }
  champion: null, // { id, name, icon }
  opponent: null, // name string (auto-detected or user-set)
  opponentIcon: null,
  manualOpponent: null, // user override
  recommendation: null, // { runeDisplay, spellDisplay, itemDisplay, runeOpponent }
  autoImport: true, // default ON: import automatically on champ select
  flashOnRight: true, // default: Flash on F (right slot / spell2)
  role: null, // null = auto-detect position; or TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY
  lastImport: null, // { ok, runes, items, error, at }
  dataInfo: null, // { source, patch, updatedAt, live, remote }
  updating: null, // { done, total, champion } while an update runs
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
    title: 'ZhuLoL',
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
  const name = champId ? await ddragon.championName(champId) : null;
  const champion = name ? { id: champId, name, icon: await ddragon.championIconUrl(name) } : null;

  // Lane opponent: enemy in the same assigned position (only if revealed).
  let opponent = null;
  let opponentIcon = null;
  if (me.assignedPosition) {
    const foe = theirTeam.find((c) => c.assignedPosition === me.assignedPosition && c.championId);
    if (foe) {
      opponent = await ddragon.championName(foe.championId);
      opponentIcon = opponent ? await ddragon.championIconUrl(opponent) : null;
    }
  }
  return { champion, opponent, opponentIcon };
}

// Compute the data freshness/source line shown in the UI.
async function refreshDataInfo() {
  const manifest = dataClient.readManifest();
  const live = dataClient.lastRemoteStatus();
  let patch = null;
  try {
    patch = await ddragon.patch(); // current public patch, e.g. "16.23"
  } catch {
    /* offline — fall back to snapshot patch below */
  }
  state.dataInfo = {
    remote: config.REMOTE_BASE || null,
    live, // null unknown, true/false after an attempt
    patch, // current live/public patch
    snapshotPatch: manifest ? manifest.patch : null,
    snapshotDate: manifest ? manifest.updatedAt : null,
  };
}

async function refreshRecommendation() {
  state.recommendation = null;
  state.error = null;
  if (!state.champion || !state.champion.name) return;
  const opp = state.manualOpponent || state.opponent || '';
  const pos = state.role || '';
  try {
    const runes = await importer.buildRunePage(state.champion.name, opp, pos);
    const items = await importer.buildItemSet(state.champion.name, state.champion.id, opp, pos);
    let spellDisplay = [];
    try {
      spellDisplay = (await importer.buildSummonerSpells(state.champion.name, opp, { flashOnRight: state.flashOnRight, position: pos })).display;
    } catch {
      /* spells optional for preview */
    }
    state.recommendation = {
      scope: runes.meta.scope, // 'overall' | 'matchup'
      runeOpponent: runes.meta.opponent, // null when overall
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
  const pos = state.role || '';
  const all = what === 'all' || what === 'both';
  const result = { ok: true, runes: false, spells: false, items: false, error: null, at: Date.now() };
  try {
    if (what === 'runes' || all) {
      const { page } = await importer.buildRunePage(state.champion.name, opp, pos);
      await importer.applyRunePage(lcu, page);
      result.runes = true;
    }
    if (what === 'spells' || all) {
      // Summoner spells can only be set during champ select.
      if (state.phase === 'ChampSelect') {
        const { selection } = await importer.buildSummonerSpells(state.champion.name, opp, { flashOnRight: state.flashOnRight, position: pos });
        await importer.applySummonerSpells(lcu, selection);
        result.spells = true;
      } else if (what === 'spells') {
        throw new Error('Summoner spells can only be set during champ select');
      }
    }
    if (what === 'items' || all) {
      const { itemSet } = await importer.buildItemSet(state.champion.name, state.champion.id, opp, pos);
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
      const { champion, opponent, opponentIcon } = await readChampSelect(session);
      state.champion = champion;
      state.opponent = opponent;
      state.opponentIcon = opponentIcon;

      const key = champion ? `${champion.id}:${state.manualOpponent || opponent || ''}:${state.role || ''}` : null;
      if (key && key !== lastChampKey) {
        lastChampKey = key;
        await refreshRecommendation();
        await refreshDataInfo(); // reflect whether the live fetch succeeded
        if (state.autoImport && state.recommendation) await doImport('both');
      }
    } else {
      state.champion = null;
      state.opponent = null;
      state.opponentIcon = null;
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
ipcMain.handle('set-flash-side', async (_e, flashOnRight) => {
  state.flashOnRight = !!flashOnRight;
  lastChampKey = null; // force preview refresh with new ordering
  await refreshRecommendation();
  push();
  return state.flashOnRight;
});
ipcMain.handle('set-role', async (_e, role) => {
  const valid = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
  state.role = valid.includes(role) ? role : null; // null = auto-detect
  lastChampKey = null; // force refresh (+ auto-import on next tick) with new role
  await refreshRecommendation();
  push();
  return state.role;
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

ipcMain.handle('get-data-info', async () => {
  await refreshDataInfo();
  return state.dataInfo;
});

// Champion list (name + icon) for the lane-opponent autocomplete.
ipcMain.handle('get-champions', async () => {
  try {
    return await ddragon.championList();
  } catch {
    return [];
  }
});

// Bulk-refresh the local cache from the deployed site, streaming progress.
ipcMain.handle('update-data', async () => {
  if (state.updating) return { ok: false, error: 'An update is already running' };
  try {
    state.updating = { done: 0, total: 0, champion: null };
    push();
    const manifest = await dataClient.updateLocalData((p) => {
      state.updating = p;
      push();
    });
    state.updating = null;
    lastChampKey = null; // next champ select will use the refreshed data
    await refreshDataInfo();
    if (state.champion) await refreshRecommendation();
    push();
    return { ok: true, manifest };
  } catch (e) {
    state.updating = null;
    push();
    return { ok: false, error: String((e && e.message) || e) };
  }
});

app.whenReady().then(async () => {
  dataClient.configure({ userDir: path.join(app.getPath('userData'), 'data') });
  await refreshDataInfo();
  createWindow();
  startLoop();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
