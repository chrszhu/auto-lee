'use strict';

// Verifies the data -> LCU mapping end to end against the BUNDLED data directory
// (data/matchup-runes, data/build-orders). No backend or client needed; the
// importer still hits Data Dragon for perk-slot resolution.

const path = require('path');

process.env.LOL_COMPANION_DATA_DIR = path.resolve(__dirname, '../data');
process.env.LOL_COMPANION_API = ''; // offline: use bundled data only
const importer = require('../src/importer');

const CHAMPS = [
  ['Blitzcrank', 53],
  ['Jhin', 202],
  ['Lux', 99],
  ['Garen', 86],
  ['MonkeyKing', 62], // name-mapping edge case (Wukong)
];

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}

async function run() {
  let failures = 0;
  for (const [champ, id] of CHAMPS) {
    try {
      const { page, display, meta } = await importer.buildRunePage(champ, '');
      assert(page.selectedPerkIds.length === 9, `${champ} rune page should have 9 perks, got ${page.selectedPerkIds.length}`);
      const runes6 = page.selectedPerkIds.slice(0, 6);
      assert(new Set(runes6).size === 6, `${champ} 6 runes should be unique, got [${runes6.join(',')}]`);
      const shards = page.selectedPerkIds.slice(6);
      shards.forEach((s) => assert(s >= 5000 && s < 5900, `${champ} shard id out of range: ${s}`));
      assert(page.primaryStyleId && page.subStyleId, `${champ} must have both styles`);
      assert(page.primaryStyleId !== page.subStyleId, `${champ} primary/secondary styles must differ`);
      // No opponent -> overall build; title is just "[Zhu] <champ>" (no "vs").
      assert(meta.scope === 'overall', `${champ} should be overall when no opponent, got ${meta.scope}`);
      assert(meta.opponent === null, `${champ} overall should have null opponent`);
      assert(!/ vs /i.test(page.name), `${champ} page name should not contain "vs": ${page.name}`);
      assert(page.name === `[Zhu] ${champ}`, `${champ} page name should be "[Zhu] ${champ}", got ${page.name}`);

      const { selection, display: spells } = await importer.buildSummonerSpells(champ, '');
      assert(selection.spell1Id && selection.spell2Id, `${champ} must have two summoner spells`);
      assert(selection.spell1Id !== selection.spell2Id, `${champ} summoner spells must be distinct`);
      // Default: Flash (id 4) on the RIGHT (spell2). Toggle swaps it to the left.
      const hasFlash = selection.spell1Id === 4 || selection.spell2Id === 4;
      if (hasFlash) {
        assert(selection.spell2Id === 4, `${champ} default should put Flash on the right (spell2)`);
        const swapped = (await importer.buildSummonerSpells(champ, '', { flashOnRight: false })).selection;
        assert(swapped.spell1Id === 4, `${champ} with flashOnRight:false should put Flash on the left (spell1)`);
      }

      // Display objects now carry icon URLs for the UI.
      assert(display.keystone && display.keystone.name, `${champ} keystone display should have a name`);
      assert(display.keystone.icon && /^https?:\/\//.test(display.keystone.icon), `${champ} keystone should have an icon URL`);
      assert(spells.every((s) => s.name && s.icon), `${champ} spell display should have name+icon`);

      const { itemSet, display: idisp } = await importer.buildItemSet(champ, id, '');
      assert(itemSet.blocks.length > 0, `${champ} item set should have blocks`);
      assert(itemSet.blocks.some((b) => b.type.startsWith('Core')), `${champ} should have a core block`);
      itemSet.blocks.forEach((b) => b.items.forEach((it) => assert(/^\d+$/.test(it.id), `${champ} item id must be numeric: ${it.id}`)));
      assert(idisp.core.every((c) => c.name && c.icon), `${champ} core item display should have name+icon`);

      const nm = (x) => (x && x.name) || '?';
      console.log(`\n✓ ${champ}`);
      console.log(`   runes: ${nm(display.keystone)} | ${nm(display.primaryStyle)} + ${nm(display.secondaryStyle)}`);
      console.log(`   spells: ${spells.map((s) => s.name).join(', ')} (ids ${selection.spell1Id}/${selection.spell2Id})`);
      console.log(`   build : start=${idisp.starting.map(nm).join('/')} boots=${idisp.boots.map(nm).join('/')} core=${idisp.core.map(nm).join(' > ')}`);
      console.log(`   blocks: ${itemSet.blocks.map((b) => `${b.type}(${b.items.length})`).join(', ')}`);
    } catch (e) {
      failures++;
      console.error(`\n✗ ${champ}: ${e.message}`);
    }
  }

  // Matchup path: an explicit opponent uses that matchup's data.
  try {
    const { page, meta } = await importer.buildRunePage('Blitzcrank', 'Thresh');
    assert(meta.scope === 'matchup', `expected matchup scope, got ${meta.scope}`);
    assert(meta.opponent === 'Thresh', `expected opponent Thresh, got ${meta.opponent}`);
    assert(page.name === '[Zhu] Blitzcrank', `matchup page name should still omit opponent, got ${page.name}`);
    assert(page.selectedPerkIds.length === 9, 'matchup page should have 9 perks');
    console.log('\n✓ matchup path: Blitzcrank vs Thresh -> scope=matchup, title omits opponent');
  } catch (e) {
    failures++;
    console.error(`\n✗ matchup path: ${e.message}`);
  }

  // Role override: a specific position uses that role's data (offline per-role file).
  try {
    const { itemSet, display } = await importer.buildItemSet('Lux', 99, '', 'MIDDLE');
    assert(display.position === 'MIDDLE', `expected MIDDLE build, got ${display.position}`);
    assert(itemSet.blocks.some((b) => b.type.startsWith('Core')), 'role build should have a core block');
    const { page } = await importer.buildRunePage('Lux', '', 'MIDDLE');
    assert(page.selectedPerkIds.length === 9, 'role rune page should have 9 perks');
    console.log('\n✓ role override: Lux MIDDLE -> position-specific build + valid runes');
  } catch (e) {
    failures++;
    console.error(`\n✗ role override: ${e.message}`);
  }

  // Build paths: each path is a coherent build; Tear only shows on paths that buy it.
  try {
    const def = await importer.buildItemSet('Veigar', 45, '', 'MIDDLE');
    const paths = def.display.paths;
    assert(paths.length >= 2, `expected multiple Veigar paths, got ${paths.length}`);
    for (const p of paths) {
      const { itemSet, display } = await importer.buildItemSet('Veigar', 45, '', 'MIDDLE', p.id);
      assert(display.selectedPathId === p.id, `path ${p.id} should be selected`);
      const core = itemSet.blocks.find((b) => b.type.startsWith('Core'));
      assert(core && core.type.includes(p.label), `core block should be ${p.label}`);
      const hasTear = core.items.some((it) => it.id === '3070');
      assert(hasTear === display.early.some((e) => e.name === 'Tear of the Goddess'), `Tear in ${p.label} must match that path's early items`);
      const start = itemSet.blocks.find((b) => b.type === 'Starting');
      const pot = start && start.items.find((it) => it.id === '2003');
      assert(pot && pot.count >= 1, `${p.label} starting block should include Health Potion(s)`);
      const { page } = await importer.buildRunePage('Veigar', '', 'MIDDLE', p.id);
      const raw = (await require('../src/dataClient').getBuildOrder('Veigar', '', 'MIDDLE')).buildPaths.find((x) => x.id === p.id);
      if (raw.runes) {
        assert(JSON.stringify(page.selectedPerkIds) === JSON.stringify(raw.runes.perkIds), `${p.label} rune page should follow the path`);
      }
    }
    console.log(`\n✓ build paths: Veigar MIDDLE -> ${paths.map((p) => p.label).join(' | ')}`);
  } catch (e) {
    failures++;
    console.error(`\n✗ build paths: ${e.message}`);
  }

  console.log(`\n${failures ? '❌' : '✅'} ${CHAMPS.length - failures}/${CHAMPS.length} champions + matchup check mapped cleanly from bundled data`);
  process.exit(failures ? 1 : 0);
}

run();
