'use strict';
// Locates the PizzaBoy install, makes sure the WebView2 host exposes a CDP
// port, and starts the game.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const APP_ID = '2238400';
const INSTALL_DIR_NAME = 'PizzaBoy';
const EXE_NAME = 'PizzaBoy.exe';
const DEBUG_FLAG = '--remote-debugging-port=';

function steamRoot() {
  const candidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Steam'),
    'C:/Program Files (x86)/Steam',
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(path.join(c, 'steamapps')));
}

/** Parse libraryfolders.vdf and return every steamapps directory. */
function steamLibraries(root) {
  const libs = [path.join(root, 'steamapps')];
  const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
  if (fs.existsSync(vdf)) {
    const text = fs.readFileSync(vdf, 'utf8');
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
      const p = path.join(m[1].split(String.fromCharCode(92, 92)).join('/'), 'steamapps');
      if (!libs.includes(p) && fs.existsSync(p)) libs.push(p);
    }
  }
  return libs;
}

/** Find the game folder, or throw with an actionable message. */
function findGameDir() {
  if (process.env.PIZZABOY_DIR) {
    if (!fs.existsSync(path.join(process.env.PIZZABOY_DIR, EXE_NAME))) {
      throw new Error(`PIZZABOY_DIR is set but ${EXE_NAME} is not in it: ${process.env.PIZZABOY_DIR}`);
    }
    return process.env.PIZZABOY_DIR;
  }
  const root = steamRoot();
  if (!root) throw new Error('Could not find a Steam installation. Set PIZZABOY_DIR to the game folder.');
  for (const lib of steamLibraries(root)) {
    const dir = path.join(lib, 'common', INSTALL_DIR_NAME);
    if (fs.existsSync(path.join(dir, EXE_NAME))) return dir;
  }
  throw new Error(`PizzaBoy (app ${APP_ID}) is not installed in any Steam library. Set PIZZABOY_DIR to override.`);
}

function readPackageJson(gameDir) {
  const file = path.join(gameDir, 'package.json');
  // The shipped file starts with a UTF-8 BOM; strip it before parsing.
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return { file, raw, json: JSON.parse(raw) };
}

/**
 * Ensure chromium-args carries the debug port. Returns a status describing
 * what happened so the CLI can explain it to the user.
 */
function ensureDebugPort(gameDir, port) {
  const { file, json } = readPackageJson(gameDir);
  const args = json['chromium-args'] || '';
  const current = args.match(/--remote-debugging-port=(\d+)/);

  if (current && Number(current[1]) === port) return { status: 'already-set', port, file };

  const backup = path.join(gameDir, 'package.json.original');
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(file, backup);
  }

  const cleaned = args.replace(/\s*--remote-debugging-port=\d+/g, '').trim();
  json['chromium-args'] = `${cleaned} ${DEBUG_FLAG}${port}`.trim();

  try {
    fs.writeFileSync(file, JSON.stringify(json, null, '\t'), 'utf8');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      const e = new Error(
        `Cannot write ${file} (needs administrator rights).\n` +
        `Fix: run this tool once from an elevated terminal, or add\n` +
        `  "${DEBUG_FLAG}${port}"\n` +
        `to "chromium-args" in that file by hand.`
      );
      e.code = 'NEEDS_ELEVATION';
      throw e;
    }
    throw err;
  }
  return { status: current ? 'port-changed' : 'added', port, file, backup };
}

function isGameRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE_NAME}`], { encoding: 'utf8' });
    return out.includes(EXE_NAME);
  } catch {
    return false;
  }
}

/** Start the game. Through Steam by default so the Steam API initialises. */
function launch(gameDir, { viaSteam = true } = {}) {
  if (viaSteam) {
    spawn('cmd', ['/c', 'start', '', `steam://rungameid/${APP_ID}`], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
    return { how: 'steam' };
  }
  spawn(path.join(gameDir, EXE_NAME), [], {
    cwd: gameDir, detached: true, stdio: 'ignore',
  }).unref();
  return { how: 'direct' };
}

/**
 * Force-quit a running game process. Used when its chromium-args were just
 * patched, since that flag only takes effect at process start -- a page
 * reload cannot open a CDP port that was never listening.
 */
function quit() {
  try {
    execFileSync('taskkill', ['/F', '/IM', EXE_NAME], { stdio: 'ignore' });
  } catch { /* already gone */ }
}

/** Poll until the game process has actually exited, or give up. */
async function waitForExit(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (isGameRunning() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isGameRunning();
}

module.exports = {
  APP_ID, EXE_NAME, findGameDir, ensureDebugPort, isGameRunning, launch, quit, waitForExit, readPackageJson,
};
