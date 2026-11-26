'use strict';

// Data Dragon helper — Riot's free static data CDN.
//
// We only need three things from it:
//   1. latest patch version
//   2. numeric championId  ->  champion name  (LCU gives us the number; our
//      backend data is keyed by name, e.g. 53 -> "Blitzcrank")
//   3. perkId -> { styleId, slot }  so we can pick two secondary runes from
//      two *different* rows (the client rejects two from the same row).

const BASE = 'https://ddragon.leagueoflegends.com';
const FALLBACK_VERSION = '14.1.1';

let cache = null; // { version, championById, perkSlotById }

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Data Dragon ${res.status} for ${url}`);
  return res.json();
}

async function latestVersion() {
  try {
    const versions = await getJson(`${BASE}/api/versions.json`);
    return Array.isArray(versions) && versions.length ? versions[0] : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

async function load() {
  if (cache) return cache;
  const version = await latestVersion();

  const champs = await getJson(`${BASE}/cdn/${version}/data/en_US/champion.json`);
  const championById = {};
  for (const c of Object.values(champs.data)) {
    championById[Number(c.key)] = c.id; // c.key is the numeric id (string), c.id is the name
  }

  const runeTrees = await getJson(`${BASE}/cdn/${version}/data/en_US/runesReforged.json`);
  const perkSlotById = {};
  for (const tree of runeTrees) {
    tree.slots.forEach((row, slotIndex) => {
      for (const rune of row.runes) {
        perkSlotById[rune.id] = { styleId: tree.id, slot: slotIndex };
      }
    });
  }

  cache = { version, championById, perkSlotById };
  return cache;
}

async function championName(championId) {
  const { championById } = await load();
  return championById[Number(championId)] || null;
}

async function perkSlot(perkId) {
  const { perkSlotById } = await load();
  return perkSlotById[perkId] || null;
}

async function version() {
  return (await load()).version;
}

// Major.minor patch string (e.g. "16.23") from the current Data Dragon version.
async function patch() {
  const v = await version();
  const parts = String(v).split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : v;
}

// All champions as [{ name, icon }], sorted by name — for the opponent picker.
async function championList() {
  const { version, championById } = await load();
  return Object.values(championById)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, icon: `${BASE}/cdn/${version}/img/champion/${name}.png` }));
}

// Square portrait for a champion (by its Data Dragon id/name, e.g. "Blitzcrank").
async function championIconUrl(name) {
  if (!name) return null;
  const { version } = await load();
  return `${BASE}/cdn/${version}/img/champion/${name}.png`;
}

module.exports = { load, latestVersion, version, patch, championName, championIconUrl, championList, perkSlot, BASE };
