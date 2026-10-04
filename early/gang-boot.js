// early/gang-boot.js
//
// One-shot BN2 gang starter. Run by early/driver.js as a separate process so
// its Singularity/gang RAM (~20GB) is only held while it's actually working -
// once the gang exists it recruits the founders, puts them to work, and exits,
// freeing that RAM for the botnet and home-RAM grind.
//
// Only valid in a BitNode whose config names a bootstrap gang faction (BN2
// today - see BITNODE in lib/config.js): it relies on being able to createGang
// at karma -9. Outside BN2 gang creation needs karma <= -54,000, so the driver
// only launches this where the shortcut exists.
//
// The heavy ongoing management (ascension, equipment, optimal tasks, territory,
// further recruiting) is intentionally NOT here - lib/gang.js does that once the
// full daemon is up. This file just gets the gang earning as early as possible.

import { forReset } from "../lib/config.js";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  const G = forReset(ns.getResetInfo()).gang;
  // Cast once here rather than at each call site: config values widen to
  // `string`, which checkJs won't accept for FactionName - including
  // player.factions.includes(), since that array is FactionName[].
  // See [[bitburner-enum-string-casts]].
  const faction = /** @type {any} */ (G.faction);
  if (!faction) {
    ns.tprint("gang-boot: this BitNode has no early-gang shortcut - exiting.");
    return;
  }

  // Phase 1: get into a gang. Combat stats and karma come from mugging here;
  // the join money requirement comes from the botnet earning in parallel.
  // checkFactionInvitations only lists the faction once ALL of those are
  // satisfied, so we just keep mugging until the invite (or gang) exists.
  while (!ns.gang.inGang()) {
    const player = ns.getPlayer();

    if ((player.factions ?? []).includes(faction)) {
      ns.gang.createGang(faction);
    } else if (ns.singularity.checkFactionInvitations().includes(faction)) {
      ns.singularity.joinFaction(faction);
    } else {
      // A crime repeats by itself once started, and commitCrime RESTARTS the
      // attempt in flight - re-issuing it every tick threw away most of a mug
      // each time. Only (re)start it when something else has taken the slot.
      // (getCurrentWork: 0.5GB on this one-shot.)
      const work = ns.singularity.getCurrentWork();
      if (!(work?.type === "CRIME" && work.crimeType === G.bootCrime)) {
        ns.singularity.commitCrime(/** @type {any} */ (G.bootCrime), true);
      }
    }

    await ns.sleep(G.bootTickMs);
  }

  // Phase 2: recruit the founding members and put them all to work, then exit.
  let i = 0;
  while (ns.gang.canRecruitMember()) {
    const name = `${G.memberPrefix}-${i}`;
    if (!ns.gang.recruitMember(name)) break;
    i++;
  }

  const members = ns.gang.getMemberNames();
  for (const name of members) {
    ns.gang.setMemberTask(name, G.bootTask);
  }

  ns.tprint(`gang-boot: ${faction} gang created, ${members.length} member(s) on "${G.bootTask}". Handing off to daemon/lib/gang.js.`);
}
