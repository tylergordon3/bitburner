// early/gang-boot.js
//
// One-shot BN2 gang starter. Run by early/driver.js as a separate process so
// its Singularity/gang RAM (~20GB) is only held while it's actually working -
// once the gang exists it recruits the founders, puts them to work, and exits,
// freeing that RAM for the botnet and home-RAM grind.
//
// Only valid in BitNode 2: it relies on being able to createGang at karma -9.
// Outside BN2 gang creation needs karma <= -54000, so the driver only launches
// this when currentNode === 2.
//
// The heavy ongoing management (ascension, equipment, optimal tasks, territory,
// further recruiting) is intentionally NOT here - lib/gang.js does that once the
// full daemon is up. This file just gets the gang earning as early as possible.

const FACTION = "Slum Snakes";
const CRIME = "Mug"; // reliable at low stats; builds combat stats + karma together
const EARLY_TASK = "Mug People"; // positive money+respect, low wanted for a combat gang
const MEMBER_PREFIX = "gord"; // matches lib/gang.js so it continues the numbering

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");

  // Phase 1: get into a gang. Combat stats (30 each) and karma (<= -9) come from
  // mugging here; the $1M join requirement comes from the botnet earning in
  // parallel. checkFactionInvitations only lists Slum Snakes once ALL of those
  // are satisfied, so we just keep mugging until the invite (or gang) exists.
  while (!ns.gang.inGang()) {
    const player = ns.getPlayer();

    if ((player.factions ?? []).includes(FACTION)) {
      ns.gang.createGang(/** @type {any} */ (FACTION));
    } else if (ns.singularity.checkFactionInvitations().includes(/** @type {any} */ (FACTION))) {
      ns.singularity.joinFaction(/** @type {any} */ (FACTION));
    } else {
      ns.singularity.commitCrime(/** @type {any} */ (CRIME), true);
    }

    await ns.sleep(15_000);
  }

  // Phase 2: recruit the founding members and put them all to work, then exit.
  let i = 0;
  while (ns.gang.canRecruitMember()) {
    const name = `${MEMBER_PREFIX}-${i}`;
    if (!ns.gang.recruitMember(name)) break;
    i++;
  }

  const members = ns.gang.getMemberNames();
  for (const name of members) {
    ns.gang.setMemberTask(name, EARLY_TASK);
  }

  ns.tprint(`gang-boot: ${FACTION} gang created, ${members.length} member(s) on "${EARLY_TASK}". Handing off to daemon/lib/gang.js.`);
}
