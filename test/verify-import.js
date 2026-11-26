'use strict';

// Verifies the IMPORT flow (importer.applyRunePage / applyItemSet) without a
// real League client: a fake LCU object records every request and simulates the
// client's page/inventory/item-set state, so we can assert the exact sequence
// of calls the client would receive.

const path = require('path');

process.env.LOL_COMPANION_DATA_DIR = path.resolve(__dirname, '../data');
process.env.LOL_COMPANION_API = ''; // offline: use bundled data only
const importer = require('../src/importer');

function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }

// A fake LCU that mimics the real client's relevant endpoints in memory.
function makeFakeLcu(initial) {
  const state = {
    pages: initial.pages.slice(),
    inventory: { ownedPageCount: initial.ownedPageCount },
    itemSets: { accountId: 1234, itemSets: initial.itemSets.slice(), timestamp: 0 },
  };
  const calls = [];
  let nextId = 1000;
  const client = {
    calls,
    async get(p) {
      calls.push(['GET', p]);
      if (p === '/lol-perks/v1/pages') return state.pages;
      if (p === '/lol-perks/v1/inventory') return state.inventory;
      if (p.startsWith('/lol-item-sets/')) return state.itemSets;
      return null;
    },
    async request(method, p, body) {
      calls.push([method, p, body]);
      if (method === 'DELETE' && p.startsWith('/lol-perks/v1/pages/')) {
        const id = Number(p.split('/').pop());
        state.pages = state.pages.filter((pg) => pg.id !== id);
        return { status: 204, body: null };
      }
      if (method === 'POST' && p === '/lol-perks/v1/pages') {
        const page = { ...body, id: ++nextId, isDeletable: true };
        state.pages.push(page);
        return { status: 200, body: page };
      }
      if (method === 'PUT' && p.startsWith('/lol-item-sets/')) {
        state.itemSets = body;
        return { status: 201, body };
      }
      if (method === 'PATCH' && p === '/lol-champ-select/v1/session/my-selection') {
        state.mySelection = { ...(state.mySelection || {}), ...body };
        return { status: 204, body: null };
      }
      return { status: 200, body: null };
    },
    _state: state,
  };
  return client;
}

async function run() {
  let failures = 0;

  // --- Rune import: client already has a user page + a stale [Companion] page,
  //     and is AT the page limit, so a page must be freed before POST. ---
  try {
    const lcu = makeFakeLcu({
      ownedPageCount: 2,
      pages: [
        { id: 1, name: 'My Page', isDeletable: true },
        { id: 2, name: '[Companion] Old', isDeletable: true },
      ],
      itemSets: [],
    });
    const { page } = await importer.buildRunePage('Jhin', '');
    await importer.applyRunePage(lcu, page);

    const posted = lcu.calls.find((c) => c[0] === 'POST' && c[1] === '/lol-perks/v1/pages');
    assert(posted, 'a rune page was POSTed');
    assert(posted[2].current === true, 'posted page is set current');
    assert(posted[2].selectedPerkIds.length === 9, 'posted page has 9 perks');
    const deletedOld = lcu.calls.some((c) => c[0] === 'DELETE' && c[1] === '/lol-perks/v1/pages/2');
    assert(deletedOld, 'stale [Companion] page was deleted');
    // After: user page kept, our new page present, still within the limit.
    const names = lcu._state.pages.map((p) => p.name);
    assert(names.includes('My Page'), "user's own page was NOT touched");
    assert(names.some((n) => n.startsWith('[Companion]')), 'new [Companion] page is present');
    assert(lcu._state.pages.filter((p) => p.isDeletable).length <= 2, 'did not exceed page limit');
    console.log('✓ rune import: freed a slot, kept user page, set new page current');
  } catch (e) { failures++; console.error('✗ rune import:', e.message); }

  // --- Item set import: must keep the user's own set and replace only ours. ---
  try {
    const lcu = makeFakeLcu({
      ownedPageCount: 2,
      pages: [],
      itemSets: [
        { title: 'My Custom AP', blocks: [] },
        { title: '[Companion] Lux', blocks: [{ type: 'old', items: [] }] },
      ],
    });
    const { itemSet } = await importer.buildItemSet('Lux', 99, '');
    await importer.applyItemSet(lcu, 777, itemSet);

    const put = lcu.calls.find((c) => c[0] === 'PUT' && c[1].startsWith('/lol-item-sets/'));
    assert(put, 'an item set PUT was made');
    assert(put[1] === '/lol-item-sets/v1/item-sets/777/sets', 'PUT targets the right summoner id');
    const titles = put[2].itemSets.map((s) => s.title);
    assert(titles.includes('My Custom AP'), "user's own item set was kept");
    assert(titles.filter((t) => t === '[Companion] Lux').length === 1, 'our old set was replaced, not duplicated');
    const ours = put[2].itemSets.find((s) => s.title === '[Companion] Lux');
    assert(ours.blocks.some((b) => b.type.startsWith('Core')), 'new set has a core block');
    assert(ours.associatedChampions.includes(99), 'new set is bound to the champion');
    console.log('✓ item import: replaced our old set, kept user set, bound to champ');
  } catch (e) { failures++; console.error('✗ item import:', e.message); }

  // --- Summoner-spell import: PATCHes my-selection with two distinct spells. ---
  try {
    const lcu = makeFakeLcu({ ownedPageCount: 2, pages: [], itemSets: [] });
    const { selection } = await importer.buildSummonerSpells('Jhin', '');
    await importer.applySummonerSpells(lcu, selection);

    const patch = lcu.calls.find((c) => c[0] === 'PATCH' && c[1] === '/lol-champ-select/v1/session/my-selection');
    assert(patch, 'a my-selection PATCH was made');
    assert(patch[2].spell1Id && patch[2].spell2Id, 'both spell ids were sent');
    assert(patch[2].spell1Id !== patch[2].spell2Id, 'the two spells are distinct');
    assert(lcu._state.mySelection.spell1Id === patch[2].spell1Id, 'client recorded the spell selection');
    console.log(`✓ spell import: set spells ${patch[2].spell1Id}/${patch[2].spell2Id} via my-selection PATCH`);
  } catch (e) { failures++; console.error('✗ spell import:', e.message); }

  // --- Full champ-select sequence (what auto-import does): runes + spells + build
  //     all land on the client, in order, with nothing clobbering the user. ---
  try {
    const lcu = makeFakeLcu({
      ownedPageCount: 2,
      pages: [{ id: 1, name: 'My Page', isDeletable: true }],
      itemSets: [{ title: 'My Custom', blocks: [] }],
    });
    const champ = 'Blitzcrank';
    const { page } = await importer.buildRunePage(champ, '');
    await importer.applyRunePage(lcu, page);
    const { selection } = await importer.buildSummonerSpells(champ, '');
    await importer.applySummonerSpells(lcu, selection);
    const { itemSet } = await importer.buildItemSet(champ, 53, '');
    await importer.applyItemSet(lcu, 777, itemSet);

    const didRunes = lcu.calls.some((c) => c[0] === 'POST' && c[1] === '/lol-perks/v1/pages');
    const didSpells = lcu.calls.some((c) => c[0] === 'PATCH' && c[1] === '/lol-champ-select/v1/session/my-selection');
    const didItems = lcu.calls.some((c) => c[0] === 'PUT' && c[1].startsWith('/lol-item-sets/'));
    assert(didRunes && didSpells && didItems, 'all three (runes, spells, build) were applied');
    assert(lcu._state.pages.some((p) => p.name === 'My Page'), 'user rune page survived');
    assert(lcu._state.itemSets.itemSets.some((s) => s.title === 'My Custom'), 'user item set survived');
    assert(lcu._state.mySelection.spell1Id, 'spells were set on the client');
    console.log('✓ full champ-select flow: runes + spells + build all imported, user data intact');
  } catch (e) { failures++; console.error('✗ full champ-select flow:', e.message); }

  console.log(`\n${failures ? '❌' : '✅'} import-flow checks ${failures ? 'FAILED' : 'passed'}`);
  process.exit(failures ? 1 : 0);
}

run();
