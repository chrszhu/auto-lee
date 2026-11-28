'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { LcuClient } = require('./lcu');
const ddragon = require('./ddragon');
const importer = require('./importer');
const dataClient = require('./dataClient');
const positions = require('./positions');
const config = require('./config');
const { autoUpdater } = require('electron-updater');
const macUpdate = require('./macUpdate');

const POLL_MS = 2000;

const lcu = new LcuClient();
let win = null;

const state = {
  appVersion: app.getVersion(),
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
  detectedPosition: null, // what auto-detect resolved to this champ select
  positionSource: null, // 'assigned' | 'quickplay' | 'smite' | 'team' | 'default' | 'mode'
  quickplay: null, // [{ champion, position, ok, error }] after filling Quickplay lobby slots
  lastImport: null, // { ok, runes, items, error, at }
  dataInfo: null, // { source, patch, updatedAt, live, remote }
  updating: null, // { done, total, champion } while a data update runs
  appUpdate: { status: 'idle', version: null, percent: 0 }, // app auto-update
  error: null,
};

let lastChampKey = null; // de-dupe recommendation fetches / auto-imports
// User-picked build path; path ids are per champion, so it only applies to that champion.
let buildPathChoice = { champion: null, id: null };

function selectedPathId() {
  return state.champion && buildPathChoice.champion === state.champion.name ? buildPathChoice.id : null;
}

function effectivePosition() {
  return state.role || state.detectedPosition || '';
}

// Per-game lookups that don't change during one champ select.
let gameCtx = { gameId: null, classic: true, slots: [] };

async function loadGameContext(gameId) {
  if (gameId && gameCtx.gameId === gameId) return gameCtx;
  gameCtx = { gameId, classic: true, slots: [] };
  try {
    const gf = await lcu.gameflowSession();
    const mapId = gf && gf.map && gf.map.id;
    const mode = gf && gf.gameData && gf.gameData.queue && gf.gameData.queue.gameMode;
    // Lanes only exist on Summoner's Rift (map 11); ARAM, Arena, Swarm etc. have none.
    if (mapId ? mapId !== 11 : mode && mode !== 'CLASSIC') gameCtx.classic = false;
  } catch {
    /* keep defaults */
  }
  try {
    const lobby = await lcu.lobby();
    const slots = lobby && lobby.localMember && lobby.localMember.playerSlots;
    gameCtx.slots = Array.isArray(slots) ? slots : [];
  } catch {
    /* no lobby (custom game etc.) */
  }
  return gameCtx;
}

// Quickplay/Swiftplay pick champions + roles in the lobby (no champ select), so
// write runes and spells straight into the lobby's player slots, as Blitz does.
let lastSlotsKey = null;
async function syncQuickplaySlots() {
  const lobby = await lcu.lobby();
  const slots = lobby && lobby.localMember && lobby.localMember.playerSlots;
  if (!Array.isArray(slots) || !slots.some((s) => s.championId > 0)) {
    state.quickplay = null;
    lastSlotsKey = null;
    return;
  }
  const key = JSON.stringify([state.flashOnRight, ...slots.map((s) => [s.championId, s.positionPreference])]);
  if (key === lastSlotsKey) return;
  lastSlotsKey = key;
  const updated = [];
  const shown = [];
  for (const s of slots) {
    const name = s.championId > 0 ? await ddragon.championName(s.championId) : null;
    const pos = positions.normalizePosition(s.positionPreference) || '';
    if (!name) {
      updated.push(s);
      continue;
    }
    try {
      const { page } = await importer.buildRunePage(name, '', pos, null);
      const next = {
        ...s,
        perks: JSON.stringify({ perkIds: page.selectedPerkIds, perkStyle: page.primaryStyleId, perkSubStyle: page.subStyleId }),
      };
      if ('spell1' in s && 'spell2' in s) {
        const { selection } = await importer.buildSummonerSpells(name, '', { flashOnRight: state.flashOnRight, position: pos });
        next.spell1 = selection.spell1Id;
        next.spell2 = selection.spell2Id;
      }
      if (state.summoner) {
        const { itemSet } = await importer.buildItemSet(name, s.championId, '', pos, null);
        await importer.applyItemSet(lcu, state.summoner.summonerId, itemSet);
      }
      updated.push(next);
      shown.push({ champion: name, position: pos || null, ok: true });
    } catch (e) {
      updated.push(s);
      shown.push({ champion: name, position: pos || null, ok: false, error: String((e && e.message) || e) });
    }
  }
  await lcu.request('PUT', '/lol-lobby/v1/lobby/members/localMember/player-slots', updated);
  state.quickplay = shown;
}

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

// Pull the local player's champion, position and best-guess lane opponent out
// of a champ select session.
async function readChampSelect(session) {
  const myTeam = session.myTeam || [];
  const theirTeam = session.theirTeam || [];
  const me = myTeam.find((c) => c.cellId === session.localPlayerCellId);
  if (!me) return { champion: null, opponent: null, locked: false, position: null, positionSource: null };

  // championId is set once the pick is LOCKED; championPickIntent is the hover.
  const locked = !!(me.championId && me.championId !== 0);
  const champId = me.championId || me.championPickIntent || 0;
  const name = champId ? await ddragon.championName(champId) : null;
  const champion = name ? { id: champId, name, icon: await ddragon.championIconUrl(name) } : null;

  const describe = async (c, key) => {
    const id = c.championId || c.championPickIntent || 0;
    const champName = id ? await ddragon.championName(id) : null;
    const games = champName ? dataClient.getRoleGames(champName) : null;
    return {
      key,
      champName,
      assigned: c.assignedPosition,
      spells: [c.spell1Id, c.spell2Id].filter(Boolean),
      probs: games && games.length ? positions.roleProbs(games) : null,
    };
  };

  const ctx = await loadGameContext(session.gameId);
  let position = null;
  let positionSource = 'mode';
  if (ctx.classic) {
    const meInfo = await describe(me, 'me');
    const allies = await Promise.all(myTeam.filter((c) => c !== me).map((c) => describe(c, `a${c.cellId}`)));
    ({ position, source: positionSource } = positions.resolveMyPosition({
      me: meInfo,
      allies,
      slotPosition: (ctx.slots.find((s) => s.championId === champId) || {}).positionPreference,
    }));
  }

  // Lane opponent: enemy assigned to our lane, else inferred from revealed picks.
  let opponent = null;
  let opponentIcon = null;
  const lane = state.role || position;
  if (lane) {
    const enemies = await Promise.all(
      theirTeam.filter((c) => c.championId).map((c) => describe(c, `e${c.cellId}`))
    );
    const key = positions.inferLaneOpponent(enemies, lane);
    const foe = enemies.find((e) => e.key === key);
    if (foe && foe.champName) {
      opponent = foe.champName;
      opponentIcon = await ddragon.championIconUrl(opponent);
    }
  }
  return { champion, opponent, opponentIcon, locked, position, positionSource };
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
  const pos = effectivePosition();
  try {
    const runes = await importer.buildRunePage(state.champion.name, opp, pos, selectedPathId());
    const items = await importer.buildItemSet(state.champion.name, state.champion.id, opp, pos, selectedPathId());
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
  const pos = effectivePosition();
  const all = what === 'all' || what === 'both';
  const result = { ok: true, runes: false, spells: false, items: false, error: null, at: Date.now() };
  try {
    if (what === 'runes' || all) {
      const { page } = await importer.buildRunePage(state.champion.name, opp, pos, selectedPathId());
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
      const { itemSet } = await importer.buildItemSet(state.champion.name, state.champion.id, opp, pos, selectedPathId());
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
      const { champion, opponent, opponentIcon, locked, position, positionSource } = await readChampSelect(session);
      state.champion = champion;
      state.opponent = opponent;
      state.opponentIcon = opponentIcon;
      state.detectedPosition = position;
      state.positionSource = positionSource;

      // dataKey = what the recommendation depends on; lock state is separate.
      // Locking a champ can reset summoner spells, so we re-import on the
      // hover -> lock transition to re-apply them (without refetching data).
      const dataKey = champion ? `${champion.id}:${state.manualOpponent || opponent || ''}:${effectivePosition()}` : null;
      const fullKey = dataKey ? `${dataKey}:${locked ? 'L' : 'H'}` : null;
      if (fullKey && fullKey !== lastChampKey) {
        const dataChanged = !lastChampKey || !lastChampKey.startsWith(`${dataKey}:`);
        lastChampKey = fullKey;
        if (dataChanged) {
          await refreshRecommendation();
          await refreshDataInfo();
        }
        if (state.autoImport && state.recommendation) await doImport('both');
      }
    } else {
      state.champion = null;
      state.opponent = null;
      state.opponentIcon = null;
      state.recommendation = null;
      state.detectedPosition = null;
      state.positionSource = null;
      lastChampKey = null;
      if (state.phase === 'Lobby' && state.autoImport) {
        try {
          await syncQuickplaySlots();
        } catch {
          state.quickplay = null; // not a Quickplay lobby, or slots not editable right now
        }
      } else if (state.phase !== 'Matchmaking' && state.phase !== 'ReadyCheck') {
        state.quickplay = null;
        lastSlotsKey = null;
      }
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

let pollTimer = null;
function startLoop() {
  tick();
  pollTimer = setInterval(tick, POLL_MS);
}

// ---- App update (GitHub Releases): detect automatically, install only when the user clicks ----
let macRelease = null; // newer release found by macUpdate.latest()

function setUpdate(patch) {
  state.appUpdate = { ...state.appUpdate, ...patch };
  push();
}

async function checkForAppUpdate() {
  const busy = ['downloading', 'installing'].includes(state.appUpdate.status);
  if (busy) return;
  if (process.platform === 'darwin') {
    try {
      macRelease = await macUpdate.latest(app.getVersion());
      setUpdate(macRelease ? { status: 'available', version: macRelease.version, error: null } : { status: 'idle' });
    } catch {
      /* offline etc. — try again next round */
    }
    return;
  }
  autoUpdater.checkForUpdates().catch(() => {});
}

function setupAutoUpdate() {
  if (!app.isPackaged) return; // only in installed builds
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => setUpdate({ status: 'available', version: info && info.version, error: null }));
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', () => {
    setUpdate({ status: 'installing', percent: 100 });
    autoUpdater.quitAndInstall(true, true); // user already asked for it: silent install, relaunch
  });
  autoUpdater.on('error', (err) => {
    if (state.appUpdate.status === 'downloading') setUpdate({ status: 'error', error: String((err && err.message) || err) });
  });

  checkForAppUpdate();
  setInterval(checkForAppUpdate, 60 * 60 * 1000);
}

async function installAppUpdate() {
  if (process.platform !== 'darwin') {
    setUpdate({ status: 'downloading', percent: 0 });
    await autoUpdater.downloadUpdate();
    return;
  }
  const appPath = macUpdate.installableAppPath();
  if (!macRelease || !appPath) {
    // e.g. running from the DMG or a quarantined copy — hand off to the release page.
    shell.openExternal(macUpdate.RELEASES_PAGE);
    return;
  }
  setUpdate({ status: 'downloading', percent: 0 });
  const dmg = await macUpdate.download(macRelease, (percent) => setUpdate({ percent }));
  setUpdate({ status: 'installing', percent: 100 });
  macUpdate.install(dmg, appPath);
  app.quit();
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
ipcMain.handle('set-build-path', async (_e, id) => {
  if (!state.champion || !state.champion.name) return null;
  buildPathChoice = { champion: state.champion.name, id: typeof id === 'string' ? id : null };
  await refreshRecommendation();
  if (state.autoImport && state.phase === 'ChampSelect' && state.recommendation) await doImport('all');
  push();
  return state.recommendation;
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

ipcMain.handle('restart-to-update', async () => {
  try {
    await installAppUpdate();
  } catch (e) {
    setUpdate({ status: 'error', error: String((e && e.message) || e) });
    return { ok: false, error: state.appUpdate.error };
  }
  return { ok: true };
});

ipcMain.handle('open-release-page', () => shell.openExternal(macUpdate.RELEASES_PAGE));

app.whenReady().then(async () => {
  dataClient.configure({ userDir: path.join(app.getPath('userData'), 'data') });
  await refreshDataInfo();
  createWindow();
  startLoop();
  setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Make sure nothing keeps the process alive after the window closes, so the app
// fully exits and never locks its own files during an update/uninstall.
app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
});

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer);
  app.quit(); // quit on all platforms when the window is closed
});
