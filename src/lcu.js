'use strict';

// LCU (League Client Update) connector.
//
// The running League client exposes a local REST API on a random port, secured
// with HTTP Basic auth (user "riot", a per-session password) over HTTPS with a
// self-signed cert. We discover the port + password the same way every
// open-source tool does: from the client process command-line args, falling
// back to the `lockfile` Riot writes into the install directory.

const https = require('https');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Riot's self-signed cert — we simply don't verify it (it's localhost only).
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

function parseFromArgs(cmdline) {
  const port = /--app-port=["']?(\d+)/.exec(cmdline);
  const token = /--remoting-auth-token=["']?([\w-]+)/.exec(cmdline);
  if (port && token) {
    return { port: Number(port[1]), token: token[1], protocol: 'https' };
  }
  return null;
}

async function fromProcess() {
  if (process.platform === 'win32') {
    // PowerShell is the most reliable way to read a full command line on Windows.
    const out = await runCmd('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine",
    ]);
    return parseFromArgs(out);
  }
  // macOS / Linux
  const out = await runCmd('/bin/sh', ['-c', 'ps -A -o args | grep -i LeagueClientUx | grep -v grep']);
  return parseFromArgs(out);
}

function lockfilePaths() {
  if (process.platform === 'win32') {
    return [
      'C:\\Riot Games\\League of Legends\\lockfile',
      path.join(os.homedir(), 'AppData', 'Local', 'Riot Games', 'League of Legends', 'lockfile'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/League of Legends.app/Contents/LoL/lockfile',
      path.join(os.homedir(), 'Applications', 'League of Legends.app', 'Contents', 'LoL', 'lockfile'),
    ];
  }
  return [];
}

function fromLockfile() {
  for (const p of lockfilePaths()) {
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      // Format: LeagueClient:<pid>:<port>:<password>:<protocol>
      const parts = raw.split(':');
      if (parts.length >= 5) {
        return { port: Number(parts[2]), token: parts[3], protocol: parts[4] };
      }
    } catch {
      /* not found / not running — try next */
    }
  }
  return null;
}

class LcuClient {
  constructor() {
    this.conn = null; // { port, token, protocol }
  }

  async connect() {
    this.conn = (await fromProcess()) || fromLockfile();
    return this.conn;
  }

  isConnected() {
    return !!this.conn;
  }

  disconnect() {
    this.conn = null;
  }

  // Core authenticated request against the local client.
  request(method, apiPath, body) {
    if (!this.conn) return Promise.reject(new Error('LCU not connected'));
    const { port, token } = this.conn;
    const payload = body != null ? JSON.stringify(body) : null;
    const auth = 'Basic ' + Buffer.from(`riot:${token}`).toString('base64');

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port,
          path: apiPath,
          method,
          agent,
          headers: {
            Authorization: auth,
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            const status = res.statusCode || 0;
            if (status === 204 || data === '') return resolve({ status, body: null });
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = data;
            }
            if (status >= 200 && status < 300) resolve({ status, body: parsed });
            else reject(Object.assign(new Error(`LCU ${method} ${apiPath} -> ${status}`), { status, body: parsed }));
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async get(p) {
    return (await this.request('GET', p)).body;
  }

  // ---- High-level helpers used by the app ----

  gameflowPhase() {
    // Returns a bare string like "ChampSelect", "InProgress", "Lobby", "None".
    return this.get('/lol-gameflow/v1/gameflow-phase');
  }

  champSelectSession() {
    return this.get('/lol-champ-select/v1/session');
  }

  currentSummoner() {
    return this.get('/lol-summoner/v1/current-summoner');
  }

  // Lobby role preferences (firstPositionPreference) survive into champ select.
  lobby() {
    return this.get('/lol-lobby/v2/lobby');
  }

  gameflowSession() {
    return this.get('/lol-gameflow/v1/session');
  }
}

module.exports = { LcuClient };
