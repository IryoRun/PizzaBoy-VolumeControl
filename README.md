# PizzaBoy VolumeControl

Separate volume sliders for **PizzaBoy** (Steam app `2238400`, by Breadless):
one for music, one for everything else. The game only ships a single master
volume, and the music runs noticeably louder than the sound effects — this
gives you two independent controls instead.

The game's own files are never modified. It attaches to the running game and
patches its audio at startup, so Steam updates and "verify integrity of game
files" have nothing to undo.

## Quick start

1. Install [Node.js](https://nodejs.org) 22 or newer, if you do not have it.
2. Download the latest release, unzip it anywhere.
3. Double-click **`PizzaBoy VolumeControl.bat`**.

First run builds a small native window using the C# compiler that ships with
Windows — no extra download, nothing to trust but the source in this repo.
After that it opens instantly. Two sliders: **Music** and **Game Sounds**.
Closing the window stops there — the game keeps running.

If PizzaBoy is already running when you start this, it reloads the game once
to install the hook, so any unsaved progress in the current session is lost.
Start it before you begin a run, not mid-run.

Your slider positions are saved and restored automatically between sessions.

## How it works

PizzaBoy is a **Construct 3** game running in a **WebView2** host, reachable
over the Chrome DevTools Protocol. The audio engine tags every sound as music
or not when it is created — that flag is the same one the split here uses, so
the two channels line up exactly with the game's own categories.

A script is injected before the game's own code runs. It patches the shared
volume-setting method on the engine's audio-instance class, so every track
gets scaled by whichever channel's slider applies, without touching anything
else about how the game plays sound. The native window (`VolumeControl.exe`,
built from `src/VolumeControl.cs`) starts a small Node.js backend
(`src/volume-tool.js`) in the background, which does the actual attaching and
patching and exposes a local HTTP API; the window just calls that API.

## Requirements

- Windows
- [Node.js](https://nodejs.org) 22 or newer
- PizzaBoy installed via Steam

## Disclaimer

Unofficial fan tool, not affiliated with Breadless. Use at your own
discretion.
