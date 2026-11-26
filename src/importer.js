'use strict';

// Maps your backend's build/rune data into the exact shapes the League client
// expects, and pushes them in via the LCU API.
//
//   Rune page : POST /lol-perks/v1/pages   (9 selectedPerkIds + 2 style ids)
//   Item set  : PUT  /lol-item-sets/v1/item-sets/{summonerId}/sets

const ddragon = require('./ddragon');
const dataClient = require('./dataClient');

const PAGE_PREFIX = '[Companion]';

// Pick the opponent entry to base runes on: the requested lane opponent if we
// have data for them, otherwise the highest-sample matchup (most representative).
function pickOpponentEntry(matchup, opponent) {
  const opponents = matchup && matchup.opponents ? matchup.opponents : {};
  if (opponent && opponents[opponent]) return { name: opponent, entry: opponents[opponent] };
  let best = null;
  for (const [name, entry] of Object.entries(opponents)) {
    const games = entry.runeGames || entry.games || 0;
    if (!best || games > best.games) best = { name, entry, games };
  }
  return best ? { name: best.name, entry: best.entry } : null;
}

function topId(group) {
  return group && group.items && group.items[0] ? group.items[0].runeId : null;
}

// Choose two secondary runes from two *different* rows of the secondary tree.
async function pickSecondaryRunes(secondaryRunes, secondaryStyleId) {
  const items = (secondaryRunes && secondaryRunes.items) || [];
  const chosen = [];
  const usedSlots = new Set();
  for (const it of items) {
    const info = await ddragon.perkSlot(it.runeId);
    if (!info || info.styleId !== secondaryStyleId) continue;
    if (usedSlots.has(info.slot)) continue;
    usedSlots.add(info.slot);
    chosen.push(it.runeId);
    if (chosen.length === 2) break;
  }
  return chosen;
}

// Assemble a complete, client-valid rune page from the matchup data.
async function buildRunePage(champion, opponent) {
  const matchup = await dataClient.getMatchupRunes(champion);
  if (!matchup || matchup.available === false) throw new Error(`No rune data for ${champion}`);
  const picked = pickOpponentEntry(matchup, opponent);
  if (!picked) throw new Error(`No matchup rune data for ${champion}`);
  const r = picked.entry.runes;

  const keystone = topId(r.keystones);
  const primaryStyleId = topId(r.primaryStyles);
  const subStyleId = topId(r.secondaryStyles);

  const primaryRunes = (r.primaryRunes && r.primaryRunes.slots ? [...r.primaryRunes.slots] : [])
    .sort((a, b) => a.slot - b.slot)
    .map((s) => (s.items && s.items[0] ? s.items[0].runeId : null))
    .filter(Boolean);

  const secondaryRunes = await pickSecondaryRunes(r.secondaryRunes, subStyleId);

  const shards = (r.statShards && r.statShards.slots ? [...r.statShards.slots] : [])
    .sort((a, b) => a.slot - b.slot)
    .map((s) => (s.items && s.items[0] ? s.items[0].runeId : null))
    .filter(Boolean);

  const selectedPerkIds = [keystone, ...primaryRunes, ...secondaryRunes, ...shards].filter(Boolean);

  if (!keystone || !primaryStyleId || !subStyleId || selectedPerkIds.length !== 9) {
    throw new Error(`Incomplete rune data (got ${selectedPerkIds.length}/9 perks)`);
  }

  const nameOf = (group) => (group && group.items && group.items[0] ? group.items[0].name : null);
  return {
    page: {
      name: `${PAGE_PREFIX} ${champion} vs ${picked.name}`.slice(0, 50),
      primaryStyleId,
      subStyleId,
      selectedPerkIds,
      current: true,
    },
    meta: { opponent: picked.name, summonerSpells: (r.summonerSpells && r.summonerSpells.items) || [] },
    display: {
      keystone: nameOf(r.keystones),
      primaryStyle: nameOf(r.primaryStyles),
      secondaryStyle: nameOf(r.secondaryStyles),
      summonerSpells: ((r.summonerSpells && r.summonerSpells.items) || []).slice(0, 2).map((s) => s.name),
    },
  };
}

async function applyRunePage(lcu, page) {
  // Clear out any page we previously created, then any deletable page if we're
  // at the inventory limit, so the POST always has room.
  const pages = (await lcu.get('/lol-perks/v1/pages')) || [];
  for (const p of pages) {
    if (typeof p.name === 'string' && p.name.startsWith(PAGE_PREFIX) && p.isDeletable) {
      await lcu.request('DELETE', `/lol-perks/v1/pages/${p.id}`);
    }
  }
  const inv = await lcu.get('/lol-perks/v1/inventory');
  if (inv && typeof inv.ownedPageCount === 'number') {
    let fresh = (await lcu.get('/lol-perks/v1/pages')) || [];
    while (fresh.filter((p) => p.isDeletable).length >= inv.ownedPageCount) {
      const victim = fresh.find((p) => p.isDeletable);
      if (!victim) break;
      await lcu.request('DELETE', `/lol-perks/v1/pages/${victim.id}`);
      fresh = (await lcu.get('/lol-perks/v1/pages')) || [];
    }
  }
  return (await lcu.request('POST', '/lol-perks/v1/pages', page)).body;
}

// ---- Summoner spells ----

// Top two distinct summoner spells for the matchup, as client spell ids.
async function buildSummonerSpells(champion, opponent) {
  const matchup = await dataClient.getMatchupRunes(champion);
  const picked = pickOpponentEntry(matchup, opponent);
  if (!picked) throw new Error(`No summoner-spell data for ${champion}`);
  const items = (picked.entry.runes && picked.entry.runes.summonerSpells && picked.entry.runes.summonerSpells.items) || [];
  const seen = new Set();
  const top = items.filter((s) => s.spellId && !seen.has(s.spellId) && seen.add(s.spellId)).slice(0, 2);
  if (top.length !== 2) throw new Error(`Incomplete summoner-spell data for ${champion}`);
  return {
    selection: { spell1Id: top[0].spellId, spell2Id: top[1].spellId },
    display: top.map((s) => s.name),
  };
}

// Only valid while in champ select — PATCHes the local player's picks.
async function applySummonerSpells(lcu, selection) {
  return (await lcu.request('PATCH', '/lol-champ-select/v1/session/my-selection', selection)).body;
}

// ---- Item set ----

function block(title, group, limit) {
  const items = ((group && group.items) || []).slice(0, limit).map((it) => ({ id: String(it.itemId), count: 1 }));
  return items.length ? { type: title, items } : null;
}

async function buildItemSet(champion, championId, opponent) {
  const build = await dataClient.getBuildOrder(champion, opponent);
  if (!build || build.available === false) throw new Error(`No build data for ${champion}`);

  // One item per core slot, in order — but the same item can be the top pick in
  // consecutive slots, so dedupe to a clean build path (keep first occurrence).
  const seenCore = new Set();
  const coreRanked = (build.slots || [])
    .sort((a, b) => a.slot - b.slot)
    .map((s) => (s.items && s.items[0] ? s.items[0] : null))
    .filter((it) => it && !seenCore.has(it.itemId) && seenCore.add(it.itemId));
  const coreItems = coreRanked.map((it) => ({ id: String(it.itemId), count: 1 }));

  const blocks = [
    block('Starting', build.starting, 3),
    block('Early', build.earlyItems, 2),
    coreItems.length ? { type: 'Core (highest win rate)', items: coreItems } : null,
    block('Boots', build.boots, 2),
    block('Support Item', build.supportItem, 1),
    block('Trinket', build.trinket, 1),
  ].filter(Boolean);

  const itemSet = {
    associatedChampions: [Number(championId)],
    associatedMaps: [11, 12],
    title: `${PAGE_PREFIX} ${champion}${opponent ? ` vs ${opponent}` : ''}`,
    type: 'custom',
    map: 'any',
    mode: 'any',
    sortrank: 1,
    startedFrom: 'blank',
    preferredItemSlots: [],
    blocks,
  };
  const names = (group, limit) => ((group && group.items) || []).slice(0, limit).map((it) => it.name);
  return {
    itemSet,
    display: {
      starting: names(build.starting, 3),
      core: coreRanked.map((it) => it.name),
      boots: names(build.boots, 1),
      position: build.position || null,
    },
  };
}

async function applyItemSet(lcu, summonerId, itemSet) {
  const current = (await lcu.get(`/lol-item-sets/v1/item-sets/${summonerId}/sets`)) || {};
  const existing = Array.isArray(current.itemSets) ? current.itemSets : [];
  // Replace any set we previously made for this champion, keep the user's own.
  const kept = existing.filter((s) => !(typeof s.title === 'string' && s.title === itemSet.title));
  const body = {
    accountId: current.accountId || summonerId,
    itemSets: [itemSet, ...kept],
    timestamp: Date.now(),
  };
  return (await lcu.request('PUT', `/lol-item-sets/v1/item-sets/${summonerId}/sets`, body)).body;
}

module.exports = {
  buildRunePage,
  applyRunePage,
  buildSummonerSpells,
  applySummonerSpells,
  buildItemSet,
  applyItemSet,
  PAGE_PREFIX,
};
