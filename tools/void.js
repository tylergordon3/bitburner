// tools/void.js
//
// The secret "The Void" achievement (THE_VOID). Its condition in the achievements
// file is a plain `false`; the real trigger is a location: The Void, a place with
// no city, grants it the moment its page is shown (bitburner-src
// Locations/ui/SpecialLocation.tsx, case LocationName.Void). By hand you get
// there from Ishima: open the location "0x6C1" (the glitch) and stay ~25 seconds.
// By script it is one call: singularity.goToLocation finds a location by name and
// only checks the city when the location HAS one (NetscriptFunctions/Singularity.ts
// goToLocation), so "The Void" opens from anywhere.
//
// NOT IN v3.0.1: the achievement, The Void's page and the glitch's warp to it were
// added after that release (bitburner-src dev, 2026-10). On v3.0.1 the call is
// refused and the glitch is a dead end; run this again once the game updates.
//
// A user-run one-shot, not part of the daemon: it moves the game's page (not your
// work - goToLocation only routes the UI), and that is your screen, not the bot's.
// Click back to wherever you were afterwards.
//
// Run:  run tools/void.js
// RAM:  1.6 base + singularity.goToLocation (5GB x the node's Singularity multiplier).

/** @param {NS} ns */
export async function main(ns) {
  const held = globalThis.gordAchievements?.ids;
  if (Array.isArray(held) && held.includes("THE_VOID")) {
    ns.tprint("void: The Void is already held - nothing to do.");
    return;
  }
  const ok = ns.singularity.goToLocation(/** @type {any} */ ("The Void"));
  ns.tprint(ok
    ? "void: opened The Void - the achievement pops within a second. Click back to where you were."
    : "void: the game refused goToLocation(\"The Void\"). This game version has no Void (it, and the " +
      "achievement, arrive after v3.0.1) - run this again once the game updates.");
}
