// tools/debt.js
//
// The "Massive debt" achievement: be $1b in debt. Almost everything in the game
// checks your balance before it charges you; classes do not (src/Work/ClassWork.tsx
// charges per cycle with no check). So: get the balance near zero, stop earning,
// and put the player and every sleeve in the dearest gym there is - Powerhouse,
// $2,400 a second each ($2,160 once its server is backdoored).
//
// That is about 13 hours with eight sleeves, during which the bot must NOT be
// earning - so this is a thing to do at the END of a node (everything bought,
// The Red Pill installed, FINISH toggled off in the HUD) or at the very start of
// one, not in the middle.
//
// Run:  killall
//       run tools/debt.js                 report what it would do, change nothing
//       run tools/debt.js --go            start (asks nothing more)
//       run tools/debt.js --go --dump "Daedalus"
//                                         first DONATE ALL MONEY to that faction
//                                         (needs donations unlocked there). Money
//                                         given away is gone - this is the point.
// Afterwards: killall; run /early/driver.js
//
// RAM: Singularity (travel, gym, donate) + sleeve calls - ~25GB at SF4.3.

const TARGET = -1e9;
const GYM_COST_PER_SEC = 120 * 20;   // gym base cost x Powerhouse costMult
const TICK_MS = 10_000;

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const go = ns.args.includes("--go");
  const dumpAt = ns.args.indexOf("--dump");
  const dumpFaction = dumpAt >= 0 ? String(ns.args[dumpAt + 1] ?? "") : "";
  const E = /** @type {any} */ (ns.enums);
  const city = E.CityName.Sector12;
  const gym = E.LocationName.Sector12PowerhouseGym;
  const stat = E.GymType.strength;

  let sleeves = 0;
  try { sleeves = ns.sleeve.getNumSleeves(); } catch { /* no sleeves in this run */ }
  const rate = GYM_COST_PER_SEC * (1 + sleeves);
  const money = ns.getPlayer().money;
  const hours = m => ((Math.max(0, m) + -TARGET) / rate / 3600).toFixed(1);

  ns.tprint(`debt: $${ns.format.number(money)} in hand, ${sleeves} sleeves -> ~$${ns.format.number(rate)}/s at ${gym}.`);
  ns.tprint(`debt: from here that is ~${hours(money)}h; from $0 it is ~${hours(0)}h. Income must be off (killall first).`);
  if (!go) {
    ns.tprint("debt: dry run - add --go to start, and --dump \"<faction>\" to donate everything first.");
    return;
  }

  // Travel first: it costs money, and a balance below zero cannot pay for it.
  try { if (ns.getPlayer().city !== city) ns.singularity.travelToCity(city); }
  catch (e) { ns.tprint(`debt: could not travel to ${city}: ${String(e)}`); }
  for (let i = 0; i < sleeves; i++) {
    try { ns.sleeve.travel(i, city); } catch { /* already there, or cannot pay */ }
  }

  if (dumpFaction) {
    const all = Math.floor(ns.getPlayer().money);
    let ok = false;
    try { ok = all > 0 && ns.singularity.donateToFaction(dumpFaction, all); } catch { /* not unlocked */ }
    ns.tprint(ok
      ? `debt: donated $${ns.format.number(all)} to ${dumpFaction}.`
      : `debt: could not donate to ${dumpFaction} (donations not unlocked there?) - carrying on with $${ns.format.number(all)} to burn.`);
  }

  let started = 0;
  for (let i = 0; i < sleeves; i++) {
    try { if (ns.sleeve.setToGymWorkout(i, gym, stat)) started++; } catch { /* shock, wrong city */ }
  }
  let self = false;
  try { self = ns.singularity.gymWorkout(gym, stat, false); } catch { /* not in Sector-12 */ }
  ns.tprint(`debt: ${started}/${sleeves} sleeves and ${self ? "you" : "NOT you"} are in the gym. Leave them there.`);
  if (!self && started === 0) return;

  while (ns.getPlayer().money > TARGET) {
    const now = ns.getPlayer().money;
    ns.print(`$${ns.format.number(now)} - ~${hours(now)}h to go`);
    await ns.sleep(TICK_MS);
  }
  // The game checks achievements every few seconds; give it one look before
  // anything can earn the balance back.
  await ns.sleep(TICK_MS);
  try { ns.singularity.stopAction(); } catch { /* nothing to stop */ }
  for (let i = 0; i < sleeves; i++) {
    try { ns.sleeve.setToIdle(i); } catch { /* fine */ }
  }
  ns.tprint("debt: $1b in debt reached - \"Massive debt\" should have popped. Restart the bot: killall; run /early/driver.js");
}
