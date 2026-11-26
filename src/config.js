'use strict';

// Central config. The remote base is your deployed analytics site; the app pulls
// fresh build/rune data from it and falls back to the bundled snapshot offline.
// Override with the LOL_COMPANION_API env var (set it to "" to disable remote,
// which the tests do so they run fully offline against the bundled data).

const DEFAULT_REMOTE = 'https://zhu-lol.vercel.app';

const REMOTE_BASE = process.env.LOL_COMPANION_API !== undefined
  ? process.env.LOL_COMPANION_API
  : DEFAULT_REMOTE;

module.exports = {
  REMOTE_BASE,
  // Per-request timeout for live data fetches during champ select.
  REQUEST_TIMEOUT_MS: 4000,
  // Concurrency when bulk-updating the local cache from the site.
  UPDATE_CONCURRENCY: 6,
};
