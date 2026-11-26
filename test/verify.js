'use strict';

// Verifies the data -> LCU mapping end to end against the BUNDLED data directory
// (data/matchup-runes, data/build-orders). No backend or client needed; the
// importer still hits Data Dragon for perk-slot resolution.

const path = require('path');

process.env.LOL_COMPANION_DATA_DIR = path.resolve(__dirname, '../data');
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
      const { page, display } = await importer.buildRunePage(champ, '');
      assert(page.selectedPerkIds.length === 9, `${champ} rune page should have 9 perks, got ${page.selectedPerkIds.length}`);
      const runes6 = page.selectedPerkIds.slice(0, 6);
      assert(new Set(runes6).size === 6, `${champ} 6 runes should be unique, got [${runes6.join(',')}]`);
      const shards = page.selectedPerkIds.slice(6);
      shards.forEach((s) => assert(s >= 5000 && s < 5900, `${champ} shard id out of range: ${s}`));
      assert(page.primaryStyleId && page.subStyleId, `${champ} must have both styles`);
      assert(page.primaryStyleId !== page.subStyleId, `${champ} primary/secondary styles must differ`);

      const { selection, display: spells } = await importer.buildSummonerSpells(champ, '');
      assert(selection.spell1Id && selection.spell2Id, `${champ} must have two summoner spells`);
      assert(selection.spell1Id !== selection.spell2Id, `${champ} summoner spells must be distinct`);

      const { itemSet, display: idisp } = await importer.buildItemSet(champ, id, '');
      assert(itemSet.blocks.length > 0, `${champ} item set should have blocks`);
      assert(itemSet.blocks.some((b) => b.type.startsWith('Core')), `${champ} should have a core block`);
      itemSet.blocks.forEach((b) => b.items.forEach((it) => assert(/^\d+$/.test(it.id), `${champ} item id must be numeric: ${it.id}`)));

      console.log(`\n✓ ${champ}`);
      console.log(`   runes: ${display.keystone} | ${display.primaryStyle} + ${display.secondaryStyle}`);
      console.log(`   spells: ${spells.join(', ')} (ids ${selection.spell1Id}/${selection.spell2Id})`);
      console.log(`   build : start=${idisp.starting.join('/')} boots=${idisp.boots.join('/')} core=${idisp.core.join(' > ')}`);
      console.log(`   blocks: ${itemSet.blocks.map((b) => `${b.type}(${b.items.length})`).join(', ')}`);
    } catch (e) {
      failures++;
      console.error(`\n✗ ${champ}: ${e.message}`);
    }
  }
  console.log(`\n${failures ? '❌' : '✅'} ${CHAMPS.length - failures}/${CHAMPS.length} champions mapped cleanly from bundled data`);
  process.exit(failures ? 1 : 0);
}

run();
