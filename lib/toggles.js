// lib/toggles.js
//
// The persisted on/off switches the HUD header flips and the daemon obeys
// (ui/dashboard.js draws them; lib/player-actions.js, lib/daemon-lib.js and
// lib/corp-daemon.js consume them). Three exist today: AUTO-FOCUS, AUTO-FINISH
// and AUTO-CORP.
//
// A toggle is just a boolean on globalThis, which every script in the game shares -
// that's what lets a DOM click handler in the HUD change what a daemon does without
// calling any ns function (calling one from an event handler stops the script). The
// only thing this module adds is DURABILITY: a page reload wipes globalThis (an aug
// install does not), and a switch the player deliberately turned off silently turning
// itself back on hours later is the exact failure both toggles exist to prevent. So
// the value is mirrored to a one-word file, seeded from it on first read, and
// rewritten whenever the in-memory value diverges.
//
// RAM: ns.read and ns.write are 0GB, so this module is free to import anywhere.
// The only cost is whatever an `onChange` callback does.

// globalThis key -> the value we last reconciled with disk. A key that's missing
// here has never been reconciled by THIS process, which is why a HUD click made
// before the first daemon read still persists correctly: the value won't match the
// (absent) entry, so it takes the write path.
const _synced = new Map();

/**
 * Read a persisted toggle, writing it back if the HUD has changed it since we last
 * looked. Anything other than the literal string "off" on disk (including an empty
 * file, or no file at all) means ON, so a fresh install defaults to the old
 * always-on behaviour.
 *
 * Call this from the code that ACTS on the toggle, every time it acts - it's the
 * reconcile point as well as the read, so a change is picked up and persisted on the
 * next tick that cares about it.
 *
 * @param {NS} ns
 * @param {{key: string, file: string, onChange?: (value: boolean) => void}} spec
 *   key      - the globalThis property the HUD writes (e.g. "gordAutoFocus")
 *   file     - where to persist it (a CONFIG.paths entry)
 *   onChange - run once when the value changes, for effects that must apply to work
 *              already in flight rather than only to the next task. Guarded, so a
 *              throwing callback can never take the caller down with it.
 * @returns {boolean}
 */
export function toggleEnabled(ns, { key, file, onChange }) {
  if (globalThis[key] === undefined) {
    let stored = "";
    try { stored = ns.read(file); } catch { /* no file yet - default on */ }
    const seeded = String(stored).trim() !== "off";
    globalThis[key] = seeded;
    _synced.set(key, seeded);
    return seeded;
  }

  const value = globalThis[key] !== false;
  if (_synced.get(key) !== value) {
    _synced.set(key, value);
    try { ns.write(file, value ? "on" : "off", "w"); } catch { /* read-only? still honour it in memory */ }
    if (onChange) {
      try { onChange(value); } catch { /* effect not applicable right now */ }
    }
  }

  return value;
}
