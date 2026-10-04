// early/stanek-boot.js
//
// Cold-boot one-shot: ACCEPT Stanek's Gift, say what happened, exit. Launched by
// early/driver.js at the very beginning of a run wherever the gift exists (BN13,
// or Source-File 13) and config wants it (stanek.enabled) - before
// early/blade-boot.js, and long before home has grown enough for the daemon.
//
// Why this is worth a script of its own: the Church of the Machine God only
// takes a player who holds NO augmentation other than NeuroFlux Governor -
// installed or queued (bitburner-src CotMG/Helper.tsx canAcceptStaneksGift) -
// and there is no second chance within a BitNode. Everything that hands out an
// augmentation is therefore a deadline: the daemon's first purchase, a graft,
// and, with Source-File 7.3, merely JOINING the Bladeburner division
// (PlayerObjectBladeburnerMethods.startBladeburner pushes The Blade's
// Simulacrum). lib/stanek.js makes the same call, but it is 18GB and waits for
// a host; this is 4.6GB and runs in the first second of the node.
//
// The outcome is published on globalThis.gordStanekState as `gate` -
// "accepted" or "refused" - together with `resetAt` (getResetInfo's
// lastNodeReset), and that pair is what the driver and the daemons wait for
// (lib/stanek-logic.js giftGate). The stamp matters: globalThis outlives a
// BitNode, so without it the LAST node's "accepted" would let this node's first
// augmentation through. Either answer is final for the node - the gift cannot be
// handed back, and a refusal means an augmentation is already owned - so nothing
// ever needs to wait on it twice.
//
// Safe to run any number of times: acceptGift on a player who already has the
// gift just returns true (NetscriptFunctions/Stanek.ts), and a live manager's
// richer state is left alone.
//
// RAM: 4.6GB = 1.6 base + 2.0 stanek.acceptGift + 1.0 getResetInfo.
//
// Args: [0] the current BitNode (the driver passes it). Optional - getResetInfo
// is paid for anyway, for the stamp.

import { forReset } from "../lib/config.js";
import { emitEvent } from "../lib/events.js";
import { hasApiAccess } from "../lib/capabilities.js";
import { giftGate } from "../lib/stanek-logic.js";

/** @param {NS} ns */
export async function main(ns) {
  const reset = ns.getResetInfo();
  const fromArg = Number(ns.args[0]);
  const node = Number.isFinite(fromArg) && fromArg > 0 ? fromArg : reset.currentNode;
  const resetAt = reset.lastNodeReset;

  // forReset, not forNode(node): the BN13 challenge run is BN13 with the gift OFF
  // (CHALLENGE in lib/config.js), and accepting it here could not be taken back.
  if (!forReset(reset).stanek.enabled) {
    ns.tprint("stanek-boot.js: Stanek's Gift is off for this run (stanek.enabled) - nothing accepted.");
    return;
  }

  const known = giftGate(globalThis.gordStanekState, resetAt);
  const accepted = ns.stanek.acceptGift();
  const gate = accepted ? "accepted" : "refused";
  const access = hasApiAccess(reset, [13]);
  const status = accepted
    ? "accepted - waiting for the manager (lib/stanek.js)"
    : access
      ? "refused: an augmentation other than NeuroFlux Governor is already owned or queued"
      : "refused: no access (not in BN13 and no Source-File 13)";

  // A running manager publishes the same gate plus everything else; do not
  // replace its state with this stub. Anything older, or another node's, goes.
  const current = globalThis.gordStanekState;
  const managed = current && current.resetAt === resetAt && current.gate === gate && current.source === "manager";
  if (!managed) {
    globalThis.gordStanekState = {
      status,
      gate,
      accepted,
      node,
      resetAt,
      source: "boot",
      updatedAt: Date.now(),
    };
  }

  if (accepted) {
    ns.tprint(known === "accepted"
      ? "stanek-boot.js: Stanek's Gift is already installed."
      : "stanek-boot.js: Stanek's Gift accepted - joined the Church of the Machine God.");
    if (known !== "accepted") {
      emitEvent("[join] Accepted Stanek's Gift (Church of the Machine God)", "faction", {
        factions: ["Church of the Machine God"],
      });
    }
  } else {
    ns.tprint(`WARN: stanek-boot.js: Stanek's Gift ${status}. The run carries on without it.`);
    if (known !== "refused") emitEvent(`[!] Stanek's Gift ${status}`, "sys");
  }
}
