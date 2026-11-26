'use strict';

// Reads build/rune data from JSON bundled inside the app (data/matchup-runes,
// data/build-orders), so the app is fully self-contained — no backend to run.
//
// The data directory can be overridden with LOL_COMPANION_DATA_DIR (used by the
// tests, and handy for pointing at a freshly-exported static-data folder).
// fs.readFileSync works on files packed inside an Electron asar, so this works
// both unpacked (dev) and packaged.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.LOL_COMPANION_DATA_DIR || path.join(__dirname, '..', 'data');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Full-sample matchup rune pages for every lane opponent of `champion`.
async function getMatchupRunes(champion) {
  const file = path.join(DATA_DIR, 'matchup-runes', `${champion}.json`);
  try {
    return readJson(file);
  } catch {
    return { champion, available: false, opponents: {} };
  }
}

// Slot-by-slot item build. The bundled snapshot is per-champion (not per
// matchup), so `opponent` is accepted for API compatibility but not used here.
async function getBuildOrder(champion, _opponent) {
  const file = path.join(DATA_DIR, 'build-orders', `${champion}.json`);
  try {
    return readJson(file);
  } catch {
    return { champion, available: false, slots: [] };
  }
}

module.exports = { DATA_DIR, getMatchupRunes, getBuildOrder };
