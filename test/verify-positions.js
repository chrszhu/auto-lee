'use strict';

// Position / lane-opponent detection from champ select (pure logic + bundled data).
process.env.LOL_COMPANION_API = '';

const dataClient = require('../src/dataClient');
const { normalizePosition, roleProbs, resolveMyPosition, inferLaneOpponent } = require('../src/positions');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`✗ ${name}: ${e.message}`);
  }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

const probs = (champ) => {
  const g = dataClient.getRoleGames(champ);
  if (!g) throw new Error(`no bundled role data for ${champ}`);
  return roleProbs(g);
};
const player = (key, champ, extra = {}) => ({ key, assigned: '', spells: [4, 14], probs: probs(champ), ...extra });

check('client strings normalize', () => {
  eq(normalizePosition('middle'), 'MIDDLE', 'middle');
  eq(normalizePosition('utility'), 'UTILITY', 'utility');
  eq(normalizePosition('FILL'), null, 'FILL');
  eq(normalizePosition('UNSELECTED'), null, 'UNSELECTED');
  eq(normalizePosition(''), null, 'empty');
});

check('ranked/draft: assigned position wins', () => {
  const r = resolveMyPosition({ me: player('me', 'Jinx', { assigned: 'middle' }), slotPosition: 'BOTTOM' });
  eq(r.position, 'MIDDLE', 'position');
  eq(r.source, 'assigned', 'source');
});

check('quickplay: slot position for the played champion', () => {
  const r = resolveMyPosition({ me: player('me', 'Jinx'), slotPosition: 'TOP' });
  eq(r.position, 'TOP', 'position');
  eq(r.source, 'quickplay', 'source');
});

check('no assignment: champion role, not a stale lobby preference', () => {
  const r = resolveMyPosition({ me: player('me', 'Jinx'), lobbyPreference: 'TOP' });
  eq(r.position, 'BOTTOM', 'position');
});

check('blind pick with Smite -> jungle', () => {
  const r = resolveMyPosition({ me: player('me', 'Garen', { spells: [4, 11] }) });
  eq(r.position, 'JUNGLE', 'position');
});

check('blind pick: Veigar with a Jinx teammate goes mid', () => {
  const r = resolveMyPosition({
    me: player('me', 'Veigar'),
    allies: [player('a1', 'Jinx'), player('a2', 'Thresh'), player('a3', 'LeeSin'), player('a4', 'Garen')],
  });
  eq(r.position, 'MIDDLE', 'position');
  eq(r.source, 'team', 'source');
});

check('lane opponent inferred from enemy picks', () => {
  const enemies = ['Ahri', 'Thresh', 'LeeSin', 'Garen', 'Jinx'].map((c, i) => ({ key: c, assigned: '', probs: probs(c) }));
  eq(inferLaneOpponent(enemies, 'MIDDLE'), 'Ahri', 'mid opponent');
  eq(inferLaneOpponent(enemies, 'BOTTOM'), 'Jinx', 'bot opponent');
  eq(inferLaneOpponent(enemies, 'JUNGLE'), 'LeeSin', 'jungle opponent');
});

check('lane opponent: unclear picks give no guess', () => {
  const enemies = [{ key: 'Thresh', assigned: '', probs: probs('Thresh') }];
  eq(inferLaneOpponent(enemies, 'MIDDLE'), null, 'mid with only a support revealed');
});

console.log(`\n${failures ? '❌' : '✅'} position detection checks ${failures ? 'failed' : 'passed'}`);
process.exit(failures ? 1 : 0);
