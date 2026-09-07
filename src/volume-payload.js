'use strict';
// Standalone audio-volume hook: two independent channels, music and every
// other sound (SFX, voice lines, UI blips). Independent of the practice
// tool's own payload (src/payload/*) -- this installs into the page on its
// own, so it works whether or not the practice tool is also attached.
//
// C3's audio engine exposes its per-track instance class straight on
// `window`: window.C3AudioInstance carries SetVolume() and IsMusic(), and
// both playback backends (C3WebAudioInstance, C3Html5AudioInstance) inherit
// them from it rather than overriding -- confirmed by listing own methods of
// all three at runtime; only the base class defines SetVolume. IsMusic() is
// exactly the split the game itself already makes, so it is also exactly
// the split between the two sliders.
//
// This script is injected via Page.addScriptToEvaluateOnNewDocument, so it
// runs before the game's own scripts -- window.C3AudioInstance does not
// exist yet at that point. main.js creates it with a plain assignment,
// `self.C3AudioInstance = class {...}` (confirmed in the shipped source), so
// a property trap on window catches the moment it is defined and patches it
// then, instead of requiring it to already exist.
//
// Every call to SetVolume() already carries `this` (the instance). We
// remember the volume the game itself asked for (before any C3 fade/mute
// logic runs) and scale it by whichever channel's factor applies.
// setMusicVolume()/setSfxVolume() then just replay SetVolume(rememberedValue)
// on every instance of that channel we've seen -- which re-enters our own
// wrapper with the current factor -- rather than needing to reach back into
// a private instance list. A recycled or already-released instance can
// throw when touched again (its buffer/gain node is gone), so one bad entry
// is dropped rather than aborting the whole re-apply pass.

(function () {
  'use strict';
  if (window.__PBP_AUDIO) return;

  let musicFactor = 1;
  let sfxFactor = 1;
  const liveMusic = new Set();
  const liveSfx = new Set();
  let installed = false;

  function installOn(Cls) {
    if (installed || !Cls || !Cls.prototype || typeof Cls.prototype.SetVolume !== 'function') return;
    const origSetVolume = Cls.prototype.SetVolume;
    Cls.prototype.SetVolume = function (v) {
      this.__pbpBaseVolume = v; // the volume as the game itself requested it
      const isMusic = typeof this.IsMusic === 'function' && this.IsMusic();
      (isMusic ? liveMusic : liveSfx).add(this);
      return origSetVolume.call(this, v * (isMusic ? musicFactor : sfxFactor));
    };
    installed = true;
  }

  // In case the class is already there (defensive; normally it is not yet).
  installOn(window.C3AudioInstance);

  // Catch the moment main.js does `self.C3AudioInstance = class {...}`.
  let _cls = window.C3AudioInstance;
  try {
    Object.defineProperty(window, 'C3AudioInstance', {
      configurable: true,
      get() { return _cls; },
      set(v) { _cls = v; installOn(v); },
    });
  } catch { /* property already non-configurable somehow; installOn() above is the fallback */ }

  function reapply(set) {
    for (const inst of set) {
      if (typeof inst.__pbpBaseVolume !== 'number') continue;
      try { inst.SetVolume(inst.__pbpBaseVolume); } catch { set.delete(inst); }
    }
  }

  function setMusicVolume(v) {
    musicFactor = Math.max(0, Math.min(1, Number(v)));
    reapply(liveMusic);
    return musicFactor;
  }

  function setSfxVolume(v) {
    sfxFactor = Math.max(0, Math.min(1, Number(v)));
    reapply(liveSfx);
    return sfxFactor;
  }

  function sample(set) {
    return [...set].slice(0, 5).map((inst) => {
      try {
        return {
          base: inst.__pbpBaseVolume,
          gain: inst._gainNode ? inst._gainNode.gain.value : undefined,
          url: typeof inst.GetUrl === 'function' ? inst.GetUrl().split('/').pop() : undefined,
        };
      } catch (err) {
        return { error: err.message };
      }
    });
  }

  window.__PBP_AUDIO = {
    get ready() { return installed; },
    setMusicVolume,
    setSfxVolume,
    getMusicVolume: () => musicFactor,
    getSfxVolume: () => sfxFactor,
    _debug: () => ({
      installed,
      music: { tracked: liveMusic.size, samples: sample(liveMusic) },
      sfx: { tracked: liveSfx.size, samples: sample(liveSfx) },
    }),
  };
})();
