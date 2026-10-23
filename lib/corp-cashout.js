// lib/corp-cashout.js
//
// One-shot: turn a corporation the bot no longer runs into player money, by
// selling the CEO's shares. Launched off-home by lib/corp-daemon.js, every tick
// it is due, in a node whose config says corp.enabled false and corp.cashOut
// true - a corporation founded before the node was switched off (the BN14 one),
// or by hand.
//
// Why selling and not dividends: after the four investment rounds the player
// owns 10% of the corp, and a dividend reaches the player as
//   (rate * cycleProfit * ownership) ^ (1 - tributeModifier)
// (Corporation.ts getCycleDividends), with tributeModifier 0.25 in BN14. At
// the BN14 corp's $15m/s profit that is ~$15k/s at a 50% payout - $100b/s of
// profit would still only pay ~$10m/s. A share sale pays ~0.8 x the player's
// share of the valuation in one go: ~$40b for that corp, simulated with the
// game's own calculateShareSale.
//
// What a step does is lib/corp-lib.js cashOutStep (pure, tested): go public if
// private, sell all but one share (in chunks of corp.cashOutMaxShares, an hour's
// cooldown apart), then report done. Publishes globalThis.gordCorpCashedOut /
// gordCorpCashOutNextAt so the daemon stops launching it while there is nothing
// to do.
//
// Arg [0]: the BitNode (the daemon passes it), so a hand-run copy can't sell a
// corp in a node that still plays it.

import { forNode } from "./config.js";
import { emitEvent } from "./events.js";
import { safe, cashOutStep } from "./corp-lib.js";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const c = ns.corporation;
  if (!c.hasCorporation()) return;

  const node = Number(ns.args[0]);
  if (!Number.isFinite(node)) {
    ns.tprint("corp-cashout.js: usage: run /lib/corp-cashout.js <bitnode> (the daemon passes this) - exiting.");
    return;
  }
  const CO = forNode(node).corp;
  if (CO.enabled || !CO.cashOut) {
    ns.print(`corp-cashout: BitNode ${node} still runs its corporation - nothing to sell.`);
    return;
  }

  const corp = safe(() => c.getCorporation());
  const step = cashOutStep(corp, CO.cashOutMaxShares);
  if (step.action === "done") {
    globalThis.gordCorpCashedOut = true;
    return;
  }
  if (step.action === "wait") {
    globalThis.gordCorpCashOutNextAt = Date.now() + Math.min(step.waitMs ?? 0, CO.cashOutRecheckMs);
    return;
  }
  if (step.action === "goPublic") {
    if (safe(() => c.goPublic(0))) emitEvent("[corp] Cash-out: went public (0 shares issued) so the shares can be sold", "corp");
    return; // sell on the next launch, from the public share price
  }

  const shares = step.shares ?? 0;
  const proceeds = safe(() => c.sellShares(shares));
  if (typeof proceeds === "number" && proceeds > 0) {
    const left = (corp?.numShares ?? 0) - shares;
    emitEvent(
      `[corp] Cash-out: sold ${ns.format.number(shares)} shares for $${ns.format.number(proceeds)}` +
      (left > 1 ? ` (${ns.format.number(left)} left - next sale after the cooldown)` : " - the corporation is cashed out"),
      "corp",
    );
    if (left <= 1) globalThis.gordCorpCashedOut = true;
  }
}
