'use strict';

// Maps your backend's build/rune data into the exact shapes the League client
// expects, and pushes them in via the LCU API.
//
//   Rune page : POST /lol-perks/v1/pages   (9 selectedPerkIds + 2 style ids)
//   Item set  : PUT  /lol-item-sets/v1/item-sets/{summonerId}/sets

const ddragon = require('./ddragon');
const dataClient = require('./dataClient');

const PAGE_PREFIX = '[Zhu]';

// Resolve the rune/spell source:
//   - a specific lane opponent -> that matchup's data (if we have it)
//   - otherwise -> the champion's OVERALL aggregate (the general build-order,
//     which carries the same rune/spell fields across all of its games).
// Returns { src, scope: 'matchup'|'overall', opponent }.
async function resolveRuneSource(champion, opponent, position) {
  if (opponent) {
    const matchup = await dataClient.getMatchupRunes(champion);
    const entry = matchup && matchup.opponents ? matchup.opponents[opponent] : null;
    if (entry && entry.runes) return { src: entry.runes, scope: 'matchup', opponent };
  }
  const build = await dataClient.getBuildOrder(champion, '', position);
  if (!build || build.available === false) throw new Error(`No data for ${champion}`);
  return { src: build, scope: 'overall', opponent: null };
}

function topId(group) {
  return group && group.items && group.items[0] ? group.items[0].runeId : null;
}

// Pick the secondary tree + two runes from it (two different rows).
//
// The secondary tree MUST differ from the primary (the client rejects same-tree
// secondaries). Aggregate "overall" data can report a secondary style equal to
// the primary, so we don't trust that field: we look at the actual secondary
// runes, drop any that belong to the primary tree, prefer the suggested style
// when it's valid, otherwise use the style of the most common remaining rune.
async function pickSecondary(secondaryRunes, primaryStyleId, preferredStyleId) {
  const items = (secondaryRunes && secondaryRunes.items) || [];
  const annotated = [];
  for (const it of items) {
    const info = await ddragon.perkSlot(it.runeId);
    if (info && info.styleId !== primaryStyleId) {
      annotated.push({ runeId: it.runeId, styleId: info.styleId, slot: info.slot });
    }
  }
  if (!annotated.length) return null;

  const styleId = preferredStyleId && preferredStyleId !== primaryStyleId && annotated.some((a) => a.styleId === preferredStyleId)
    ? preferredStyleId
    : annotated[0].styleId;

  const chosen = [];
  const usedSlots = new Set();
  for (const a of annotated) {
    if (a.styleId !== styleId || usedSlots.has(a.slot)) continue;
    usedSlots.add(a.slot);
    chosen.push(a.runeId);
    if (chosen.length === 2) break;
  }
  return { styleId, runes: chosen };
}

// Assemble a complete, client-valid rune page (overall, or matchup-specific).
// With build paths, the page follows the chosen path (or the most played one)
// unless a matchup page applies and the user hasn't picked a path.
async function buildRunePage(champion, opponent, position, pathId) {
  const { src: r, scope, opponent: oppName } = await resolveRuneSource(champion, opponent, position);

  if (scope === 'overall' || pathId) {
    const build = scope === 'overall' ? r : await dataClient.getBuildOrder(champion, '', position);
    const paths = build && Array.isArray(build.buildPaths) ? build.buildPaths : [];
    const path = paths.find((p) => p.id === pathId) || paths[0];
    const pr = path && path.runes;
    if (pr && Array.isArray(pr.perkIds) && pr.perkIds.length === 9 && pr.primaryStyle.runeId !== pr.subStyle.runeId) {
      const lite = (x) => ({ name: x.name, icon: x.icon || null });
      return {
        page: {
          name: `${PAGE_PREFIX} ${champion}`.slice(0, 50),
          primaryStyleId: pr.primaryStyle.runeId,
          subStyleId: pr.subStyle.runeId,
          selectedPerkIds: pr.perkIds,
          current: true,
        },
        meta: {
          scope: scope === 'overall' ? 'overall' : 'path',
          opponent: null,
          pathLabel: path.core && path.core[0] ? `${path.core[0].name} build` : path.label,
          summonerSpells: (build.summonerSpells && build.summonerSpells.items) || [],
        },
        display: { keystone: lite(pr.keystone), primaryStyle: lite(pr.primaryStyle), secondaryStyle: lite(pr.subStyle) },
      };
    }
  }

  const keystone = topId(r.keystones);
  const primaryStyleId = topId(r.primaryStyles);

  const primaryRunes = (r.primaryRunes && r.primaryRunes.slots ? [...r.primaryRunes.slots] : [])
    .sort((a, b) => a.slot - b.slot)
    .map((s) => (s.items && s.items[0] ? s.items[0].runeId : null))
    .filter(Boolean);

  const sec = await pickSecondary(r.secondaryRunes, primaryStyleId, topId(r.secondaryStyles));
  const subStyleId = sec ? sec.styleId : null;
  const secondaryRunes = sec ? sec.runes : [];

  const shards = (r.statShards && r.statShards.slots ? [...r.statShards.slots] : [])
    .sort((a, b) => a.slot - b.slot)
    .map((s) => (s.items && s.items[0] ? s.items[0].runeId : null))
    .filter(Boolean);

  const selectedPerkIds = [keystone, ...primaryRunes, ...secondaryRunes, ...shards].filter(Boolean);

  if (!keystone || !primaryStyleId || !subStyleId || subStyleId === primaryStyleId || selectedPerkIds.length !== 9) {
    throw new Error(`Incomplete rune data for ${champion} (got ${selectedPerkIds.length}/9 perks)`);
  }

  const topOf = (group) => (group && group.items && group.items[0]
    ? { name: group.items[0].name, icon: group.items[0].icon || null }
    : null);
  // Reflect the actually-chosen secondary style (may differ from the raw top).
  const subItem = (r.secondaryStyles && r.secondaryStyles.items
    ? r.secondaryStyles.items.find((s) => s.runeId === subStyleId)
    : null);
  return {
    page: {
      name: `${PAGE_PREFIX} ${champion}`.slice(0, 50),
      primaryStyleId,
      subStyleId,
      selectedPerkIds,
      current: true,
    },
    meta: { scope, opponent: oppName, summonerSpells: (r.summonerSpells && r.summonerSpells.items) || [] },
    display: {
      keystone: topOf(r.keystones),
      primaryStyle: topOf(r.primaryStyles),
      secondaryStyle: subItem ? { name: subItem.name, icon: subItem.icon || null } : topOf(r.secondaryStyles),
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

const FLASH_ID = 4;

// Top two distinct summoner spells for the matchup, as client spell ids.
// Slot order: spell1Id = left (bound to D by default), spell2Id = right (F).
// By default we put Flash on the RIGHT (F); `flashOnRight: false` swaps it to the
// left. If neither spell is Flash, frequency order is kept and the toggle just
// swaps the two.
async function buildSummonerSpells(champion, opponent, opts = {}) {
  const flashOnRight = opts.flashOnRight !== false; // default true
  const { src } = await resolveRuneSource(champion, opponent, opts.position);
  const items = (src.summonerSpells && src.summonerSpells.items) || [];
  const seen = new Set();
  const top = items.filter((s) => s.spellId && !seen.has(s.spellId) && seen.add(s.spellId)).slice(0, 2);
  if (top.length !== 2) throw new Error(`Incomplete summoner-spell data for ${champion}`);

  let ordered = top;
  const flash = top.find((s) => s.spellId === FLASH_ID);
  const other = top.find((s) => s.spellId !== FLASH_ID);
  if (flash && other) ordered = flashOnRight ? [other, flash] : [flash, other];
  else if (!flashOnRight) ordered = [top[1], top[0]]; // no flash: toggle still swaps

  return {
    selection: { spell1Id: ordered[0].spellId, spell2Id: ordered[1].spellId },
    display: ordered.map((s) => ({ name: s.name, icon: s.icon || null })),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Set summoner spells (only valid during champ select). The client sometimes
// ignores or resets a spell change (notably right around lock-in), which makes
// auto-set look flaky — so we PATCH, then read the session back and retry until
// the slots actually match (or we run out of attempts).
async function applySummonerSpells(lcu, selection) {
  const patch = () => lcu.request('PATCH', '/lol-champ-select/v1/session/my-selection', selection);
  await patch();
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(250);
    let me = null;
    try {
      const session = await lcu.get('/lol-champ-select/v1/session');
      me = session && (session.myTeam || []).find((c) => c.cellId === session.localPlayerCellId);
    } catch {
      /* session read failed — try again */
    }
    if (me && me.spell1Id === selection.spell1Id && me.spell2Id === selection.spell2Id) {
      return true; // confirmed applied
    }
    await patch();
  }
  return false;
}

// ---- Item set ----

function block(title, group, limit) {
  const items = ((group && group.items) || []).slice(0, limit).map((it) => ({ id: String(it.itemId), count: it.count || 1 }));
  return items.length ? { type: title, items } : null;
}

async function buildItemSet(champion, championId, opponent, position, pathId) {
  const build = await dataClient.getBuildOrder(champion, opponent, position);
  if (!build || build.available === false) throw new Error(`No build data for ${champion}`);

  const paths = Array.isArray(build.buildPaths) ? build.buildPaths : [];
  const chosen = paths.find((p) => p.id === pathId) || paths[0] || null;

  // Fallback for data without paths: one item per slot, deduped.
  const seenCore = new Set();
  const coreRanked = chosen
    ? chosen.core
    : (build.slots || [])
        .sort((a, b) => a.slot - b.slot)
        .map((s) => (s.items && s.items[0] ? s.items[0] : null))
        .filter((it) => it && !seenCore.has(it.itemId) && seenCore.add(it.itemId));
  const ids = (list) => list.map((it) => ({ id: String(it.itemId), count: 1 }));
  const pctTag = (p) => `${Math.round(p.pct)}% of games${p.winRate != null ? `, ${Math.round(p.winRate)}% WR` : ''}`;
  const pathName = (p) => `${p.core[0] ? p.core[0].name : p.label} build`;

  let blocks;
  if (chosen) {
    // Path items only: Tear etc. appear only when this path actually buys them.
    const early = (chosen.early || []).filter((e) => e.pct >= 40);
    const alts = (chosen.tree || []).slice(1);
    const opening = chosen.startingSet && chosen.startingSet.items.length
      ? chosen.startingSet
      : { items: chosen.starting && chosen.starting.length ? chosen.starting : (build.starting || {}).items };
    blocks = [
      block('Starting', opening, 4),
      { type: `Core: ${pathName(chosen)} (${pctTag(chosen)})`, items: ids([...early, ...chosen.core]) },
      alts.length ? { type: 'Or for item 2', items: ids(alts) } : null,
      chosen.late && chosen.late.length ? { type: 'Situational', items: ids(chosen.late) } : null,
      ...paths
        .filter((p) => p !== chosen)
        .slice(0, 2)
        .map((p) => ({ type: `Alt: ${pathName(p)} (${pctTag(p)})`, items: ids(p.core) })),
      block('Boots', { items: chosen.boots && chosen.boots.length ? chosen.boots : (build.boots || {}).items }, 2),
      block('Support Item', build.supportItem, 1),
      block('Trinket', build.trinket, 1),
    ].filter((b) => b && b.items.length);
  } else {
    blocks = [
      block('Starting', build.starting, 3),
      block('Early', build.earlyItems, 2),
      coreRanked.length ? { type: 'Core', items: ids(coreRanked) } : null,
      block('Boots', build.boots, 2),
      block('Support Item', build.supportItem, 1),
      block('Trinket', build.trinket, 1),
    ].filter(Boolean);
  }

  const itemSet = {
    associatedChampions: [Number(championId)],
    associatedMaps: [11, 12],
    title: `${PAGE_PREFIX} ${champion}`,
    type: 'custom',
    map: 'any',
    mode: 'any',
    sortrank: 1,
    startedFrom: 'blank',
    preferredItemSlots: [],
    blocks,
  };
  const icons = (group, limit) => ((group && group.items) || []).slice(0, limit).map((it) => ({ name: it.name, icon: it.icon || null }));
  const lite = (list) => (list || []).map((it) => ({ name: it.count > 1 ? `${it.name} ×${it.count}` : it.name, icon: it.icon || null }));
  const withPct = (group, limit) => ((group && group.items) || []).slice(0, limit)
    .map((it) => ({ name: it.name, icon: it.icon || null, pct: it.pct, winRate: it.winRate ?? null }));
  const slotStats = [
    { label: 'Starting', items: withPct(build.starting, 4) },
    { label: 'Early', items: withPct(build.earlyItems, 3) },
    ...(build.slots || []).slice().sort((a, b) => a.slot - b.slot)
      .map((s) => ({ label: `Item ${s.slot}`, items: withPct(s, 4) })),
    { label: 'Boots', items: withPct(build.boots, 3) },
  ].filter((s) => s.items.length);
  return {
    itemSet,
    display: {
      starting: chosen && chosen.startingSet
        ? lite(chosen.startingSet.items)
        : chosen && chosen.starting && chosen.starting.length ? lite(chosen.starting.slice(0, 3)) : icons(build.starting, 3),
      early: chosen ? lite((chosen.early || []).filter((e) => e.pct >= 40)) : [],
      core: lite(coreRanked),
      boots: chosen && chosen.boots && chosen.boots.length ? lite(chosen.boots.slice(0, 1)) : icons(build.boots, 1),
      position: build.position || null,
      selectedPathId: chosen ? chosen.id : null,
      paths: paths.map((p) => ({
        id: p.id,
        name: pathName(p),
        pct: p.pct,
        winRate: p.winRate,
        lowSample: !!p.lowSample,
        badge: p.badge || null,
        icon: p.core[0] ? p.core[0].icon || null : null,
        core: lite([...(p.early || []).filter((e) => e.pct >= 40), ...p.core]),
      })),
      slotStats,
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
