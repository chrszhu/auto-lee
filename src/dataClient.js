'use strict';

// Build/rune data access with a live-first strategy:
//   1. the deployed site (config.REMOTE_BASE) — always fresh, when online
//   2. a writable local cache (userDir) populated by the Update button
//   3. the snapshot bundled in the app (data/) — guaranteed offline fallback
//
// LOL_COMPANION_DATA_DIR overrides the bundled dir (used by tests).

const fs = require('fs');
const path = require('path');
const config = require('./config');

const BUNDLED_DIR = process.env.LOL_COMPANION_DATA_DIR || path.join(__dirname, '..', 'data');

let userDir = null; // writable cache dir, set by configure()
let lastRemoteOk = null; // null = unknown, true/false after a remote attempt

function configure(opts = {}) {
  if (opts.userDir) userDir = opts.userDir;
}

function remoteEnabled() {
  return !!config.REMOTE_BASE;
}

// ---- local file access ----

function localDirs() {
  return [userDir, BUNDLED_DIR].filter(Boolean);
}

function readLocal(subdir, champion) {
  for (const dir of localDirs()) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, subdir, `${champion}.json`), 'utf8'));
    } catch {
      /* try next dir */
    }
  }
  return null;
}

// ---- remote access ----

async function fetchRemote(pathname, timeoutMs = config.REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.REMOTE_BASE}${pathname}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    lastRemoteOk = true;
    return json;
  } catch (e) {
    lastRemoteOk = false;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---- public data accessors (live-first) ----

async function getMatchupRunes(champion) {
  if (remoteEnabled()) {
    try {
      const data = await fetchRemote(`/api/champion-matchup-runes/${encodeURIComponent(champion)}`);
      if (data && data.available !== false) return data;
    } catch {
      /* fall through to local */
    }
  }
  return readLocal('matchup-runes', champion) || { champion, available: false, opponents: {} };
}

async function getBuildOrder(champion, opponent, position) {
  if (remoteEnabled()) {
    try {
      const params = [];
      if (opponent) params.push(`opponent=${encodeURIComponent(opponent)}`);
      if (position) params.push(`position=${encodeURIComponent(position)}`);
      const q = params.length ? `?${params.join('&')}` : '';
      const data = await fetchRemote(`/api/champion-build-order/${encodeURIComponent(champion)}${q}`);
      if (data && data.available !== false) return data;
    } catch {
      /* fall through to local */
    }
  }
  // Offline: a per-position snapshot file if a role was requested, else default.
  if (position) {
    const byPos = readLocal('build-orders', `${champion}_${position}`);
    if (byPos && byPos.available !== false) return byPos;
  }
  return readLocal('build-orders', champion) || { champion, available: false, slots: [] };
}

// ---- champion list (for bulk update) ----

const roleCache = new Map();

// {position, games}[] for a champion from the local build snapshot (no network).
function getRoleGames(champion) {
  if (!roleCache.has(champion)) {
    const d = readLocal('build-orders', champion);
    roleCache.set(champion, (d && d.availablePositions) || null);
  }
  return roleCache.get(champion);
}

async function getChampionList() {
  if (remoteEnabled()) {
    try {
      const data = await fetchRemote('/api/champions', 15000);
      if (data && data.data) return Object.keys(data.data);
    } catch {
      /* fall through */
    }
  }
  // Fallback: derive from locally present matchup-rune files.
  for (const dir of localDirs()) {
    try {
      return fs.readdirSync(path.join(dir, 'matchup-runes')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    } catch {
      /* next */
    }
  }
  return [];
}

// ---- freshness / manifest ----

function patchOf(buildOrder) {
  return (buildOrder && buildOrder.window && buildOrder.window.patches && buildOrder.window.patches[0]) || null;
}

function readManifest() {
  for (const dir of localDirs()) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      /* next */
    }
  }
  return null;
}

function lastRemoteStatus() {
  return lastRemoteOk;
}

// Bulk-refresh the local cache from the site. Calls onProgress({done,total,champion}).
async function updateLocalData(onProgress) {
  if (!remoteEnabled()) throw new Error('No remote site configured');
  if (!userDir) throw new Error('No writable cache directory configured');

  const champions = await getChampionList();
  if (!champions.length) throw new Error('Could not fetch champion list from the site');

  fs.mkdirSync(path.join(userDir, 'matchup-runes'), { recursive: true });
  fs.mkdirSync(path.join(userDir, 'build-orders'), { recursive: true });

  let done = 0;
  let failed = 0;
  let patch = null;
  const total = champions.length;
  const queue = champions.slice();

  async function worker() {
    for (;;) {
      const champ = queue.shift();
      if (!champ) return;
      try {
        const runes = await fetchRemote(`/api/champion-matchup-runes/${encodeURIComponent(champ)}`, 15000);
        fs.writeFileSync(path.join(userDir, 'matchup-runes', `${champ}.json`), JSON.stringify(runes));
      } catch {
        failed++;
      }
      try {
        const build = await fetchRemote(`/api/champion-build-order/${encodeURIComponent(champ)}`, 15000);
        fs.writeFileSync(path.join(userDir, 'build-orders', `${champ}.json`), JSON.stringify(build));
        patch = patch || patchOf(build);
      } catch {
        /* non-fatal */
      }
      done++;
      if (onProgress) onProgress({ done, total, champion: champ });
    }
  }

  const workers = Array.from({ length: Math.min(config.UPDATE_CONCURRENCY, total) }, worker);
  await Promise.all(workers);

  const manifest = {
    updatedAt: new Date().toISOString(),
    patch: patch || null,
    source: config.REMOTE_BASE,
    champions: total - failed,
  };
  fs.writeFileSync(path.join(userDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

module.exports = {
  configure,
  remoteEnabled,
  getMatchupRunes,
  getBuildOrder,
  getRoleGames,
  getChampionList,
  readManifest,
  lastRemoteStatus,
  updateLocalData,
  BUNDLED_DIR,
};
