#!/usr/bin/env node
'use strict';
// PizzaBoy VolumeControl -- headless backend. It attaches to the running
// game over CDP, installs a hook that splits every sound into two channels
// -- music and everything else (see volume-payload.js for how) -- and
// exposes a tiny local HTTP API to drive them independently. Closing this
// does not touch the game.
//
// This process owns no window of its own. The native window is
// VolumeControl.exe, built from VolumeControl.cs (plain WinForms, no
// browser engine involved anywhere); it starts this backend as a hidden
// child process and talks to it over that HTTP API.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { attach, DEFAULT_PORT } = require('./cdp');
const launcher = require('./launcher');

const CDP_PORT = Number(process.env.PIZZABOY_PORT || DEFAULT_PORT);
const API_PORT = Number(process.env.PIZZABOY_VOLUME_API_PORT || 9333);
const STATE_FILE = path.join(__dirname, '..', 'states', 'audio-volume.json');
const PAYLOAD_SOURCE = fs.readFileSync(path.join(__dirname, 'volume-payload.js'), 'utf8');

function log(...a) { console.log('[volumecontrol]', ...a); }

function clamp01(v) { return Math.max(0, Math.min(1, Number(v))); }

function loadSaved() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      music: typeof raw.music === 'number' ? clamp01(raw.music) : 1,
      sfx: typeof raw.sfx === 'number' ? clamp01(raw.sfx) : 1,
    };
  } catch { /* first run, or no saved value yet */ }
  return { music: 1, sfx: 1 };
}

function saveVolumes(v) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(v, null, 2));
  } catch (err) {
    log('could not save volume to disk:', err.message);
  }
}

/** Start the game if needed, then install the audio hook and reload. */
async function connectAndInstall() {
  const gameDir = launcher.findGameDir();

  // Always ensure the debug port first. A Steam update can silently reset
  // package.json, so a previously-patched install can un-patch itself.
  const res = launcher.ensureDebugPort(gameDir, CDP_PORT);
  if (res.status !== 'already-set') {
    log(`added --remote-debugging-port=${CDP_PORT} to package.json (backup: package.json.original)`);
  }

  let running = launcher.isGameRunning();

  // chromium-args only take effect at process start, so a running game whose
  // package.json we just changed is still listening on no CDP port at all --
  // no amount of reloading will ever open one. It has to be restarted.
  if (running && res.status !== 'already-set') {
    log('PizzaBoy is running with an outdated configuration -- restarting it once to enable the audio hook (unsaved progress is lost).');
    launcher.quit();
    running = !(await launcher.waitForExit());
    if (running) throw new Error('PizzaBoy would not close. Close it by hand and try again.');
  }

  if (!running) {
    log('starting PizzaBoy via Steam...');
    launcher.launch(gameDir);
  } else {
    log('PizzaBoy already running -- reloading it once to install the audio hook (unsaved progress is lost).');
  }

  log(`waiting for the game page on port ${CDP_PORT}...`);
  const { session } = await attach(CDP_PORT, 120000);
  log('attached; installing audio-volume hook...');

  await session.send('Page.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: PAYLOAD_SOURCE });

  const loaded = new Promise((resolve) => {
    const off = session.on('Page.loadEventFired', () => { off(); resolve(); });
    setTimeout(() => { off(); resolve(); }, 30000);
  });
  await session.send('Page.reload', { ignoreCache: false });
  await loaded;

  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      if (await session.evaluate('!!(window.__PBP_AUDIO && window.__PBP_AUDIO.ready)')) { ready = true; break; }
    } catch { /* page is mid-navigation */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('Audio hook did not come up after reload.');
  log('audio hook live.');
  return session;
}

function startApiServer(session, initial) {
  const current = { ...initial };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(current));
      return;
    }
    if (url.pathname === '/set') {
      const channel = url.searchParams.get('channel');
      if (channel !== 'music' && channel !== 'sfx') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'channel must be "music" or "sfx"' }));
        return;
      }
      const v = clamp01(url.searchParams.get('v'));
      current[channel] = v;
      saveVolumes(current);
      const call = channel === 'music' ? 'setMusicVolume' : 'setSfxVolume';
      session.evaluate(`window.__PBP_AUDIO && window.__PBP_AUDIO.${call}(${v})`)
        .then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ channel, volume: v }));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(API_PORT, '127.0.0.1', () => log(`API listening on http://127.0.0.1:${API_PORT}/`));
  return server;
}

async function main() {
  const initial = loadSaved();
  const session = await connectAndInstall();
  await session.evaluate(`window.__PBP_AUDIO && window.__PBP_AUDIO.setMusicVolume(${initial.music})`);
  await session.evaluate(`window.__PBP_AUDIO && window.__PBP_AUDIO.setSfxVolume(${initial.sfx})`);
  startApiServer(session, initial);

  log('backend ready. Press Ctrl+C here to stop it (the game keeps running).');
  await new Promise(() => {}); // stay attached
}

main().catch((err) => {
  console.error('[volumecontrol]', err.message);
  process.exit(1);
});
