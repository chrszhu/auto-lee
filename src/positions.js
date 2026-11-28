'use strict';

// Figures out which lane the local player is in during champ select, and who
// their lane opponent is, from what the client exposes.

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const SMITE_IDS = new Set([11]);

const ALIASES = {
  top: 'TOP',
  jungle: 'JUNGLE',
  jg: 'JUNGLE',
  middle: 'MIDDLE',
  mid: 'MIDDLE',
  bottom: 'BOTTOM',
  bot: 'BOTTOM',
  adc: 'BOTTOM',
  utility: 'UTILITY',
  support: 'UTILITY',
};

// Client strings ("middle", "UTILITY", "FILL", "") -> one of ROLES or null.
function normalizePosition(p) {
  if (!p || typeof p !== 'string') return null;
  return ALIASES[p.trim().toLowerCase()] || null;
}

// availablePositions [{position, games}] -> {ROLE: probability}, lightly smoothed
// so an off-role pick is unlikely rather than impossible.
function roleProbs(availablePositions) {
  const games = {};
  let total = 0;
  for (const { position, games: g } of availablePositions || []) {
    const r = normalizePosition(position);
    if (!r || !(g > 0)) continue;
    games[r] = (games[r] || 0) + g;
    total += g;
  }
  const out = {};
  for (const r of ROLES) out[r] = total ? ((games[r] || 0) + 0.005 * total) / (1.025 * total) : 0.2;
  return out;
}

// entries: [{ key, probs: {ROLE: p}, fixed?: ROLE }] (at most 5).
// Returns {key: ROLE} for the most likely one-champion-per-role assignment.
function assignRoles(entries) {
  const list = entries.slice(0, 5);
  let best = { score: -Infinity, roles: null };
  const used = new Set();
  const picked = [];
  (function dfs(i, score) {
    if (score <= best.score) return;
    if (i === list.length) {
      best = { score, roles: picked.slice() };
      return;
    }
    const e = list[i];
    for (const r of e.fixed ? [e.fixed] : ROLES) {
      if (used.has(r)) continue;
      const p = e.fixed ? 1 : e.probs[r] || 1e-6;
      used.add(r);
      picked.push(r);
      dfs(i + 1, score + Math.log(p));
      picked.pop();
      used.delete(r);
    }
  })(0, 0);
  const out = {};
  if (best.roles) list.forEach((e, i) => (out[e.key] = best.roles[i]));
  return out;
}

// me: { key, assigned, spells:[ids], probs }, allies: [{ key, assigned, spells, probs }]
// slotPosition: Quickplay lobby slot position for the champion being played (may be null).
// Returns { position, source } where source explains how it was decided.
// Same priority as Blitz: assigned role, else the champion's usual role. The
// lobby's firstPositionPreference is ignored — it lingers from earlier queues.
function resolveMyPosition({ me, allies = [], slotPosition = null }) {
  const assigned = normalizePosition(me.assigned);
  if (assigned) return { position: assigned, source: 'assigned' };
  const slot = normalizePosition(slotPosition);
  if (slot) return { position: slot, source: 'quickplay' };
  if ((me.spells || []).some((s) => SMITE_IDS.has(s))) return { position: 'JUNGLE', source: 'smite' };
  if (!me.probs) return { position: null, source: 'default' };

  // Blind pick: place the whole team so teammates' likely roles are respected.
  const team = [me, ...allies.filter((a) => a.probs || normalizePosition(a.assigned))].map((a) => ({
    key: a.key,
    probs: a.probs || {},
    fixed:
      normalizePosition(a.assigned) || ((a.spells || []).some((s) => SMITE_IDS.has(s)) ? 'JUNGLE' : undefined),
  }));
  const roles = assignRoles(team);
  return roles[me.key] ? { position: roles[me.key], source: 'team' } : { position: null, source: 'default' };
}

// Enemy positions are hidden in champ select, so infer the most likely lane for
// each revealed enemy and return the one placed in `myPosition` (if confident).
function inferLaneOpponent(enemies, myPosition, minProb = 0.3) {
  if (!myPosition) return null;
  const direct = enemies.find((e) => normalizePosition(e.assigned) === myPosition);
  if (direct) return direct.key;
  const known = enemies.filter((e) => e.probs);
  if (!known.length) return null;
  const roles = assignRoles(known.map((e) => ({ key: e.key, probs: e.probs, fixed: normalizePosition(e.assigned) || undefined })));
  const hit = known.find((e) => roles[e.key] === myPosition);
  return hit && (hit.probs[myPosition] || 0) >= minProb ? hit.key : null;
}

module.exports = { ROLES, normalizePosition, roleProbs, assignRoles, resolveMyPosition, inferLaneOpponent };
