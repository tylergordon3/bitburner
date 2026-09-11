// early/blade-boot.js
//
// Cold-boot one-shot for Bladeburner nodes (CONFIG.bladeburner.enabled - BN6):
// gym every combat stat to the division's join gate, join, start a Bladeburner
// action, exit. Launched by early/driver.js, the same way early/gang-boot.js is,
// so the division is running long before home has grown enough for the daemon.
//
// Why this is worth a script: the division - rank, skills, black ops - is reset
// by entering a NEW BitNode (not by an aug install), and joining needs 100
// strength/defense/dexterity/agility plus BN6/BN7 or SF6/SF7 (no location
// requirement; see bitburner-src NetscriptFunctions/Bladeburner.ts). Until the
// player has joined, nothing else Bladeburner can happen.
//
// Gym costs are paid per second and CAN take money negative; Bladeburner
// contracts ($250k base each) pay that back quickly once the division is up.
//
// Once joined it starts CONFIG.bladeburner.bootAction (Training) and exits:
// Bladeburner actions repeat by themselves, so the slot stays productive until
// bn6/daemon.js's action loop (lib/bladeburner.js) takes over.
//
// Args: [0] the current BitNode (the driver passes it; getResetInfo is 1GB).

import { CONFIG, forNode } from "../lib/config.js";
import { emitEvent } from "../lib/events.js";

// GymType ids for gymWorkout next to the player.skills field each trains.
const STATS = [
  { gym: "str", skill: "strength" },
  { gym: "def", skill: "defense" },
  { gym: "dex", skill: "dexterity" },
  { gym: "agi", skill: "agility" },
];

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const B = forNode(Number(ns.args[0] ?? 0)).bladeburner;
  if (!B.enabled) {
    ns.tprint("blade-boot.js: Bladeburner is off for this BitNode (CONFIG.bladeburner.enabled) - exiting.");
    return;
  }
  const gym = /** @type {any} */ (CONFIG.player.gym);

  while (true) {
    const bb = ns.bladeburner;

    if (bb.inBladeburner()) {
      const cur = bb.getCurrentAction();
      if (!cur || cur.type === "Idle") {
        bb.startAction(/** @type {any} */ ("General"), /** @type {any} */ (B.bootAction));
      }
      ns.tprint(`blade-boot.js: in the Bladeburner division - ${B.bootAction} running until the daemon takes over.`);
      return;
    }

    const skills = ns.getPlayer().skills;
    const short = STATS
      .filter(s => (skills[s.skill] ?? 0) < (B.joinStats[s.skill] ?? 0))
      .sort((a, b) => skills[a.skill] - skills[b.skill]);

    if (short.length === 0) {
      if (!bb.joinBladeburnerDivision()) {
        ns.tprint("blade-boot.js: combat stats are met but joining failed (no BN6/7 or SF6/7 access?) - exiting.");
        return;
      }
      ns.tprint("Joined the Bladeburner division.");
      emitEvent("[join] Joined the Bladeburner division", "faction");
      continue; // start the boot action on the next pass
    }

    // Weakest stat first. Re-issued every pass (like the daemon's own work), so
    // anything that interrupted the workout is overridden on the next tick.
    const s = short[0];
    const focus = String(ns.read(CONFIG.paths.focusFile)).trim() !== "off";
    ns.singularity.gymWorkout(gym, /** @type {any} */ (s.gym), focus);
    ns.print(`Training ${s.skill} ${Math.floor(skills[s.skill])}/${B.joinStats[s.skill]} for the Bladeburner division.`);
    await ns.sleep(B.bootTickMs);
  }
}
