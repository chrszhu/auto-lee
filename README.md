# LoL Companion (ad-free)

A small, ad-free desktop companion for League of Legends. When you enter champ
select it detects your champion (and lane opponent when revealed), looks up the
recommended runes and item build, and imports them straight into the League
client — rune page and item set, one click or fully automatic.

It talks to Riot's **local client API (LCU)** — the same documented local
interface every open-source rune-importer uses. No ads, no accounts, no upsells.
Not affiliated with or endorsed by Riot Games or Blitz.

## How it fits together

```
League Client ──(LCU API, localhost)── LoL Companion
   runes/items  <────── import ──────   (build/rune data bundled inside the app)
```

- **Data** is bundled inside the app (`data/matchup-runes`, `data/build-orders`),
  exported from `match-analytics-fastapi` — itself built from public Riot
  Match-V5 data + Data Dragon. No backend/server required; works fully offline.
- **Client glue** (champ-select detection, rune/item import) is done through the
  LCU API, discovered from the client's process args or its `lockfile`.
- **Champion/rune IDs** are resolved via Riot's free Data Dragon CDN (the one
  thing that needs internet, and only to map the client's numeric IDs to names).

## Install (Windows) — easiest

1. Go to the [**Releases**](https://github.com/chrszhu/auto-lee/releases) page and
   download the latest `LoLCompanion-Setup-<version>.exe`.
2. Run it. Windows SmartScreen may warn (the installer is unsigned): click
   **More info → Run anyway**.
3. Launch **LoL Companion**, open League, and click **Test connection** to confirm
   it sees your client.

That's it — the build/rune data is bundled, so there's nothing else to install or
run.

## Quick start (once installed)

1. Open League of Legends and log in.
2. Open **LoL Companion** → click **Test connection (read-only)**. You should see
   `Connected ✓ <your name> · <phase> · N rune pages`.
3. Enter champ select. The panel shows your champion with recommended **runes**,
   **summoner spells**, and **build**.
4. Click **Import all (runes + spells + build)** — or flip on **Auto-import on
   champ select** to have it happen automatically every game.
   - Summoner spells can only be set *during* champ select (the Spells button is
     disabled otherwise — that's a Riot API rule, not a bug).

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
npm run dist:win    # -> dist-installers/LoLCompanion-Setup-<version>.exe  (NSIS)
npm run dist:mac    # -> dist-installers/*.dmg
```

Notes:
- Building a **Windows** installer from **macOS/Linux** works (electron-builder
  fetches a bundled Wine), but it's most reliable on Windows or in CI.
- The installers are **unsigned**. On first launch, Windows SmartScreen
  ("More info → Run anyway") / macOS Gatekeeper will warn. For wide
  distribution, add code-signing certs to the `build` config.

### Config

| Env var                  | Default            | Purpose                                  |
| ------------------------ | ------------------ | ---------------------------------------- |
| `LOL_COMPANION_DATA_DIR` | `<app>/data`       | Point at a different build/rune snapshot.|

## Using it

1. `npm start` (or launch the installed app).
2. Open League and enter champ select — the panel shows your champion plus the
   recommended runes and build.
3. Click **Import runes**, **Import build**, or **Import both** — or flip on
   **Auto-import on champ select** to have it happen automatically every game.
4. Wrong matchup? Type the enemy laner into the **Lane opponent** box.

## Refreshing the bundled data

The bundled data is a snapshot. To update it to a newer patch, re-export from the
analytics project and recopy:

```bash
cp -R ../match-analytics-fastapi/static-data/matchup-runes data/
cp -R ../match-analytics-fastapi/static-data/build-orders data/
npm run dist:win   # rebuild the installer
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
  `[Companion]` and are safe to delete; your own pages/sets are never touched.
- Client discovery: Windows uses PowerShell/lockfile; macOS uses `ps`/lockfile.
- Only touches the **client** (never the game) — no memory reading, no injection,
  no gameplay automation.

## Roadmap

- In-game overlay via Riot's official Live Client Data API (port 2999)
- Post-game match analytics
- Summoner-spell auto-set
- Per-role build toggles
