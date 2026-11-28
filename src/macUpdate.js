'use strict';

// Self-update for the unsigned macOS build. Squirrel.Mac (electron-updater's
// mac path) refuses unsigned apps, so: read latest-mac.yml from the GitHub
// release, download the DMG, verify its sha512, then swap the .app after quit.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RELEASE_BASE = 'https://github.com/chrszhu/auto-lee/releases/latest/download';
const RELEASES_PAGE = 'https://github.com/chrszhu/auto-lee/releases/latest';

function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Minimal parse of electron-builder's latest-mac.yml (version + first dmg).
function parseLatest(yml) {
  const version = (yml.match(/^version:\s*['"]?([\d.]+)/m) || [])[1];
  const file = (yml.match(/^\s+-\s+url:\s*(\S+\.dmg)\s*\n\s+sha512:\s*(\S+)/m) || []).slice(1);
  if (!version || file.length !== 2) return null;
  return { version, file: file[0], sha512: file[1] };
}

// -> { version, file, sha512 } if a newer release exists, else null.
async function latest(currentVersion) {
  const res = await fetch(`${RELEASE_BASE}/latest-mac.yml`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`update check failed (${res.status})`);
  const rel = parseLatest(await res.text());
  if (!rel) throw new Error('could not read latest-mac.yml');
  return newer(rel.version, currentVersion) ? rel : null;
}

async function download(rel, onPercent) {
  if (!/^[\w.-]+\.dmg$/.test(rel.file)) throw new Error('unexpected update file name');
  const res = await fetch(`${RELEASE_BASE}/${rel.file}`);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const dest = path.join(os.tmpdir(), rel.file);
  const out = fs.createWriteStream(dest);
  const hash = crypto.createHash('sha512');
  let got = 0;
  let lastPct = -1;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    got += value.length;
    if (!out.write(value)) await new Promise((r) => out.once('drain', r));
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct !== lastPct) onPercent((lastPct = pct));
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  if (hash.digest('base64') !== rel.sha512) {
    fs.rmSync(dest, { force: true });
    throw new Error('downloaded update failed integrity check');
  }
  return dest;
}

// The running .app bundle, if it can be replaced in place.
function installableAppPath() {
  const appPath = path.resolve(process.execPath, '../../..');
  if (!appPath.endsWith('.app') || appPath.startsWith('/Volumes/') || appPath.includes('/AppTranslocation/')) return null;
  try {
    fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
    return appPath;
  } catch {
    return null;
  }
}

const SCRIPT = `#!/bin/bash
PID="$1"; DMG="$2"; APP="$3"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
MNT="$(mktemp -d /tmp/zhulol-mnt.XXXXXX)"
if hdiutil attach -nobrowse -quiet -mountpoint "$MNT" "$DMG"; then
  SRC="$(ls -d "$MNT"/*.app 2>/dev/null | head -1)"
  if [ -n "$SRC" ]; then
    rm -rf "$APP.old"
    if mv "$APP" "$APP.old" && ditto "$SRC" "$APP"; then
      rm -rf "$APP.old"
    else
      rm -rf "$APP"; mv "$APP.old" "$APP"
    fi
  fi
  hdiutil detach -quiet "$MNT"
fi
rmdir "$MNT" 2>/dev/null
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
rm -f "$DMG"
open "$APP"
`;

// Spawns the swap script; caller must quit the app right after.
function install(dmgPath, appPath) {
  const script = path.join(os.tmpdir(), 'zhulol-update.sh');
  fs.writeFileSync(script, SCRIPT, { mode: 0o700 });
  spawn('/bin/bash', [script, String(process.pid), dmgPath, appPath], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { latest, download, install, installableAppPath, newer, parseLatest, RELEASES_PAGE };
