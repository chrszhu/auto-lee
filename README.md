# ZhuLoL (ad-free)

A small, ad-free desktop companion for League of Legends. When you enter champ
select it detects your champion (and lane opponent when revealed), looks up the
recommended runes and item build, and imports them straight into the League
client — rune page and item set, one click or fully automatic.

It talks to Riot's **local client API (LCU)** — the same documented local
interface every open-source rune-importer uses. No ads, no accounts, no upsells.
Not affiliated with or endorsed by Riot Games or Blitz.

## How it fits together

```
League Client ──(LCU API, localhost)── ZhuLoL ──(HTTPS)── your site (zhu-lol.vercel.app)
   runes/items  <────── import ──────                  ──────>   fresh builds/runes/matchups
                                         fallback ── bundled snapshot (offline)
```

- **Data is live-first:** it fetches fresh build/rune data from your deployed
  site on every champ select, and falls back to the **bundled snapshot**
  (`data/`) when offline. The snapshot is exported from `match-analytics-fastapi`
  (public Riot Match-V5 data + Data Dragon), so it always works even with no net.
- An **Update data from site** button re-downloads the whole dataset into a local
  cache, so your offline fallback is fresh too. The current data source + patch +
  snapshot date are shown in the app.
- **Client glue** (champ-select detection, rune/spell/item import) is done through
  the LCU API, discovered from the client's process args or its `lockfile`.
- **IDs + icons** (champions, runes, spells, items) come from Riot's free Data
  Dragon CDN.

## Install (Windows) — easiest

1. Go to the [**Releases**](https://github.com/chrszhu/auto-lee/releases) page and
   download the latest `ZhuLoL-Setup-<version>.exe`.
2. Run it. Windows SmartScreen may warn (the installer is unsigned): click
   **More info → Run anyway**.
3. Launch **ZhuLoL**, open League, and click **Test connection** to confirm
   it sees your client.

That's it — the build/rune data is bundled, so there's nothing else to install or
run.

## Quick start (once installed)

1. Open League of Legends and log in.
2. Open **ZhuLoL** → click **Test connection (read-only)**. You should see
   `Connected ✓ <your name> · <phase> · N rune pages`.
3. Enter champ select. The panel shows your champion with recommended **runes**,
   **summoner spells**, and **build**.
4. **Auto-import is ON by default** — runes + spells + build are imported for you
   automatically on champ select. (Turn off **Auto-import on champ select** if you
   prefer to click **Import all** yourself.)
   - **Role / lane:** defaults to auto-detect; override it with the **Role** dropdown
     (Top/Jungle/Mid/Bot/Support) to get a position-specific build.
   - Summoner spells can only be set *during* champ select (that's a Riot API rule).
   - **Flash side:** Flash is on the **right (F)** by default; uncheck **Flash on
     right (F)** to put it on the **left (D)**.
   - Leave the **lane opponent** blank for the overall build, or pick one for a
     matchup-specific build.

## Prerequisites

- **To use the packaged installer:** nothing — just install and open League.
- **To run/build from source:** Node.js 20+ and the League client open.

## Run from source

```bash
npm install
npm start
```

## Build an installer

```bash
npm run dist:win    # -> dist-installers/ZhuLoL-Setup-<version>.exe  (NSIS)
npm run dist:mac    # -> dist-installers/*.dmg
```

Notes:
- Building a **Windows** installer from **macOS/Linux** works (electron-builder
  fetches a bundled Wine), but it's most reliable on Windows or in CI.
- The installers are **unsigned**. On first launch, Windows SmartScreen
  ("More info → Run anyway") / macOS Gatekeeper will warn. For wide
  distribution, add code-signing certs to the `build` config.

### Config

| Env var                  | Default                      | Purpose                                                 |
| ------------------------ | ---------------------------- | ------------------------------------------------------- |
| `LOL_COMPANION_API`      | `https://zhu-lol.vercel.app` | Live data site. Set to `""` to force offline (bundled). |
| `LOL_COMPANION_DATA_DIR` | `<app>/data`                 | Point at a different bundled build/rune snapshot.       |

## Using it

1. `npm start` (or launch the installed app).
2. Open League and enter champ select — the panel shows your champion plus the
   recommended runes and build.
3. Click **Import runes**, **Import build**, or **Import both** — or flip on
   **Auto-import on champ select** to have it happen automatically every game.
4. Wrong matchup? Type the enemy laner into the **Lane opponent** box.

## How current is the data? (data freshness)

**Live-first.** When online, the app pulls build/rune data straight from your site
(`LOL_COMPANION_API`, default `https://zhu-lol.vercel.app`) on each champ select —
so it reflects whatever your site currently serves (latest patch, newest sample
sizes). The data line in the app shows the live/offline status, patch, and the
local snapshot date.

**Offline fallback.** If the site is unreachable, it uses a local cache, then the
snapshot bundled in the installer — so it still works with no internet.

**Update button.** *Update data from site* re-downloads the entire dataset from
your site into a writable local cache (`<userData>/data`) and stamps it with the
date/patch, keeping your offline fallback fresh too. It never needs a new
installer for data — only app code changes do.

To refresh the **bundled** snapshot shipped in the installer (optional, for a
better offline baseline):

```bash
cp -R ../riot/lol/match-analytics-fastapi/static-data/matchup-runes data/
cp -R ../riot/lol/match-analytics-fastapi/static-data/build-orders data/
node -e "require('fs').writeFileSync('data/manifest.json', JSON.stringify({updatedAt:new Date().toISOString(),source:'bundled snapshot'},null,2))"
npm run dist:win
```

## Verify

```bash
npm test   # maps bundled data -> client-valid rune pages + item sets,
           # and checks the import flow against a simulated client
```

## Notes & limits (MVP)

- If the lane opponent isn't revealed yet, runes fall back to the highest-sample
  matchup for your champion. Override it manually anytime. Item builds from the
  bundled snapshot are per-champion (not per-matchup).
- Rune pages are assembled to be client-valid (keystone + 3 primary + 2
  secondary from different rows + 3 shards). Imported pages/sets are prefixed
  `[Zhu]` and are safe to delete; your own pages/sets are never touched.
- Client discovery: Windows uses PowerShell/lockfile; macOS uses `ps`/lockfile.
- Only touches the **client** (never the game) — no memory reading, no injection,
  no gameplay automation.

## Roadmap

- In-game overlay via Riot's official Live Client Data API (port 2999)
- Post-game match analytics
- Summoner-spell auto-set
- Per-role build toggles
