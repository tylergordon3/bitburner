// lib/blade-daemon.js
//
// The strategy shared by the two Bladeburner nodes - bn6/daemon.js and
// bn7/daemon.js are each a few lines on top of this. The skeleton is still
// lib/daemon-core.js (runDaemon + decideAugFlow); what this file owns is HOW a
// Bladeburner node spends the player's work slot and when it ends.
//
// Both nodes cut hacking hard (HackingLevelMultiplier 0.35, reduced hack exp and
// server money) and double the world daemon's hacking requirement, so the usual
// finish is a very long way off. What they hand you instead is the BLADEBURNER
// division:
//   - contracts pay money; every success pays RANK (x0.6 in both nodes)
//   - rank pays Bladeburners faction reputation (its augs are the node's best,
//     The Blade's Simulacrum among them) and skill points
//   - rank gates the black ops, and the last one - Operation Daedalus - ends
//     the BitNode without going near w0r1d_d43m0n
//   - rank and skills survive aug installs (only a new BitNode resets them)
// So the player's work slot belongs to Bladeburner. The work itself runs in two
// off-home helpers (every ns.bladeburner.* call is 4GB): lib/bladeburner.js, the
// action loop, placed AHEAD of the sleeve manager (priorityHelpers), and
// lib/blade-upkeep.js for skills / city / the faction join. Sleeves (SF10) work
// for the division too - see lib/sleeves.js's Bladeburner mode.
//
// ── Who gets the work slot ───────────────────────────────────────────────────
// A Bladeburner action and ordinary work cancel each other, so the daemon
// decides each tick and publishes gordBladeControl.allow (see lib/bladeburner.js):
//   1. Before the division exists: gym to 100 in every combat stat, then join.
//   2. The Blade's Simulacrum installed: both at once - the helper runs actions,
//      and the slot runs the ordinary aug flow (decideAugFlow) alongside.
//   3. Action loop not running yet (waiting for RAM): the ordinary aug flow, so
//      the slot never idles.
//   4. Otherwise Bladeburner - lent out only while it RESTS (stamina recovers
//      passively whatever the slot does), to faction work for the best aug that
//      isn't from the Bladeburners faction.
// Rep for those other factions is stamped as the faction grind each tick
// (recordFactionWork) so a sleeve that isn't on Bladeburner work can mirror it.
//
// ── Finishing ────────────────────────────────────────────────────────────────
// plannedNextBN (lib/bladeburner-logic.js plannedNodeAfterBlade): a daemon arg
// wins (`run bn7/daemon.js 8`); otherwise the node re-enters itself while the
// Source-File level this run awards is below cfg.bladeburner.reenterUntilSF (0
// for BN6 = halt, 3 for BN7 = collect SF7.3's free Simulacrum). While halted -
// or while the HUD's FINISH is off - the action loop runs every black op EXCEPT
// Operation Daedalus and announces that it's ready. With both unlocked it runs
// Daedalus, and the daemon then launches lib/finish-bn.js in "blade" mode, whose
// destroyW0r1dD43m0n accepts a full black-op record in place of the backdoor.

import {
  maybeAutoTravelForReadyFaction,
  trainCombatIfNeeded,
  clearFactionWork,
  recordFactionWork,
  updateRepRate,
} from "./player-actions.js";
import { getAllAugCandidates, getMoneyHoardGoal } from "./aug-targets.js";
import { emitEvent } from "./events.js";
import {
  maybeBuyInfra,
  inGangSafe,
  startBestFactionWork,
  gangFactionName,
  autoFinishEnabled,
  ensureHelper,
} from "./daemon-lib.js";
import { runDaemon, decidePrelude, decideAugFlow, decideNoTarget } from "./daemon-core.js";
import { plannedNodeAfterBlade } from "./bladeburner-logic.js";

/**
 * Run a Bladeburner node's daemon. `cfg` is forNode(6) or forNode(7); the
 * differences between the two nodes are entirely in lib/config.js.
 * @param {NS} ns @param {any} cfg
 */
export async function runBladeDaemon(ns, cfg) {
  const d = new BladeDaemon(cfg);
  await runDaemon(ns, {
    cfg,
    self: cfg.paths.daemon,
    plannedNextBN: ns => d.plannedNextBN(ns),
    setupGang: ns => d.maybeSetupGang(ns),
    decide: ns => d.decideNextPriority(ns),
    // The action loop is the node's engine: placed before the sleeve manager and
    // required (a warning if nothing has room). Upkeep can wait for a host.
    priorityHelpers: [
      { script: cfg.paths.bladeburner, optional: false },
      { script: cfg.paths.bladeUpkeep, optional: true },
    ],
    // Sleeves are a real part of the engine here (attempt generation + contracts),
    // so a manager that can't find a host is worth a warning.
    sleevesOptional: false,
    afterDecide: (ns, state) => d.afterDecide(ns, state),
    statusLine: ns => d.statusLine(ns),
  });
}

class BladeDaemon {
  /** @param {any} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.BL = cfg.bladeburner;
    this.GANG = cfg.gang;
    this.HACKING_FACTIONS = new Set(cfg.factions.hackingFocused);
    // Cast to any[] so its elements don't trip checkJs against FactionName - see
    // [[bitburner-enum-string-casts]].
    this.CRIMINAL_FACTIONS = /** @type {any[]} */ (cfg.gang.criminalFactions);
    // The work-slot handshake with lib/bladeburner.js: set once this tick's
    // decision has handed the slot to ordinary work.
    this._slotClaimed = false;
    this._finishAllowed = false;
  }

  /**
   * The BitNode to enter once the node is won (0 = halt for manual selection).
   * getResetInfo is 0GB.
   * @param {NS} ns
   */
  plannedNextBN(ns) {
    const info = ns.getResetInfo();
    return plannedNodeAfterBlade({
      override: ns.args[0] != null ? Number(ns.args[0]) : null,
      currentNode: info.currentNode,
      sfLevel: info.ownedSF.get(info.currentNode) ?? 0,
      reenterUntilSF: this.BL.reenterUntilSF,
    });
  }

  /**
   * Found a gang the moment we're eligible (karma past the gate AND in a criminal
   * faction). Never ground toward: sleeve crime karma gets there on its own, and
   * the player's slot is Bladeburner's. Same as BN9's.
   * @param {NS} ns
   */
  maybeSetupGang(ns) {
    if (inGangSafe(ns)) return null;

    const player = ns.getPlayer();
    if ((player.karma ?? 0) > this.GANG.karma) return null;

    const joined = player.factions ?? [];
    const faction = this.CRIMINAL_FACTIONS.find(f => joined.includes(f));
    if (!faction) {
      return { action: "Gang (karma ready)", detail: "Awaiting a criminal faction invite" };
    }

    try {
      if (ns.gang.createGang(/** @type {any} */ (faction))) {
        ns.tprint(`Created gang with ${faction}!`);
        return { action: "Gang Created", detail: faction };
      }
    } catch { /* no SF2 in this run - nothing to found */ }

    return null;
  }

  // ── The work-slot handshake with lib/bladeburner.js ─────────────────────────

  /**
   * Publish who owns the player's slot. Called with false the moment the daemon is
   * about to issue ordinary work (so the action loop can't start an action over
   * it), and once more after the decision with the final answer.
   */
  publishControl(allow) {
    globalThis.gordBladeControl = { allow, finishAllowed: this._finishAllowed, at: Date.now() };
  }

  claimSlot() {
    this._slotClaimed = true;
    this.publishControl(false);
  }

  releaseSlot() {
    this._slotClaimed = false;
    this.publishControl(true);
  }

  /** The action loop's published state, or null when it isn't running/fresh. */
  bladeState() {
    const b = globalThis.gordBladeState;
    if (!b?.joined || Date.now() - (b.updatedAt ?? 0) > this.BL.controlStaleMs) return null;
    return b;
  }

  /** @param {NS} ns */
  hasSimulacrum(ns) {
    return ns.singularity.getOwnedAugmentations(false).includes(this.BL.simulacrumAug);
  }

  /**
   * Two targets instead of one. `target` is what the node is working toward
   * overall (HUD, server budget): anything buyable now, else the best Bladeburners
   * aug - its rep comes from rank, which the slot is earning anyway - else the ETA
   * leader. `repTarget` is the best aug whose rep needs ordinary faction work (not
   * Bladeburners, not the gang's passive faction): the rest phases' job.
   * @param {NS} ns
   */
  pickTargets(ns) {
    const candidates = getAllAugCandidates(ns);
    const gangFaction = gangFactionName(ns);
    const bladeAug = candidates.find(c => c.faction === this.BL.faction);
    const target = candidates.find(c => c.canBuy) ?? bladeAug ?? candidates[0] ?? null;
    const repTarget = candidates.find(
      c => c.faction !== this.BL.faction && c.faction !== gangFaction && c.repMissing > 0
    ) ?? null;
    return { target, repTarget };
  }

  /**
   * The ordinary (BN4-style) use of the slot, for when it isn't Bladeburner's -
   * Simulacrum installed, or the action loop not placed yet. decideAugFlow would
   * try to "work" for the Bladeburners faction (it offers no work - its rep is
   * rank), so a Bladeburners target is swapped for the rep target, or idle work.
   * @param {NS} ns @param {any} c
   */
  async ordinaryFlow(ns, { target, repTarget, opportunities, infra }, note) {
    const bladeRepOnly = target && target.faction === this.BL.faction && target.repMissing > 0;
    const t = bladeRepOnly ? repTarget : target;
    const state = t
      ? await decideAugFlow(ns, { cfg: this.cfg, target: t, infra, opportunities, incomeLabel: "Bladeburner/hacking income" })
      : await decideNoTarget(ns, { opportunities, infra });
    return note ? { ...state, detail: `${state.detail} | ${note}` } : state;
  }

  // ── Strategy ─────────────────────────────────────────────────────────────────

  /** @param {NS} ns */
  async decideNextPriority(ns) {
    const BL = this.BL;
    this._slotClaimed = false;
    this._finishAllowed = this.plannedNextBN(ns) > 0 && autoFinishEnabled(ns);
    clearFactionWork();

    const opportunities = decidePrelude(ns);

    // Travel is instant and touches neither kind of work.
    const autoTravel = await maybeAutoTravelForReadyFaction(ns, opportunities);
    if (autoTravel) return { ...autoTravel, target: null, infra: null };

    const { target, repTarget } = this.pickTargets(ns);
    // Keep an ETA for the rep target too (decidePrelude only samples the main one).
    if (repTarget) updateRepRate(ns, repTarget.faction);

    // Money-gated endgame invites: hold cash once every other requirement is met.
    const hoard = getMoneyHoardGoal(ns);
    globalThis.gordMoneyFloor = hoard ? hoard.money : 0;

    const infra = await maybeBuyInfra(ns, target);

    // 1. No division yet: the gym to the join gate, then join.
    if (!ns.bladeburner.inBladeburner()) {
      this.claimSlot();
      const training = await trainCombatIfNeeded(ns, BL.joinStats);
      if (training) {
        return { ...training, detail: `${training.detail} (for the Bladeburner division)`, target, infra };
      }
      if (ns.bladeburner.joinBladeburnerDivision()) {
        ns.tprint("Joined the Bladeburner division.");
        emitEvent("[join] Joined the Bladeburner division", "faction");
        this.releaseSlot();
        return { action: "Bladeburner", detail: "joined the division", bladePhase: "join", target, infra };
      }
      // Stats are met but the join failed (no BN6/7 or SF6/7 access?) - fall back.
      return this.ordinaryFlow(ns, { target, repTarget, opportunities, infra }, "Bladeburner join failed");
    }

    // Other factions' rep is stamped for any sleeve not on Bladeburner work.
    if (repTarget) {
      recordFactionWork(repTarget.faction, this.HACKING_FACTIONS.has(repTarget.faction) ? "hacking" : "field");
    }

    // 2. Simulacrum: Bladeburner and ordinary work run side by side.
    if (this.hasSimulacrum(ns)) {
      return this.ordinaryFlow(ns, { target, repTarget, opportunities, infra }, "Bladeburner running alongside (Simulacrum)");
    }

    // 3. The action loop isn't up (waiting for a host): keep the slot productive.
    const blade = this.bladeState();
    if (!blade) {
      this.claimSlot();
      return this.ordinaryFlow(ns, { target, repTarget, opportunities, infra }, `${this.cfg.paths.bladeburner} not running`);
    }

    // 4. Bladeburner's slot - lent to faction work while it rests.
    if (blade.resting && repTarget && BL.factionWorkWhileResting) {
      this.claimSlot();
      const type = startBestFactionWork(ns, repTarget.faction);
      if (type) {
        const stamina = blade.maxStamina > 0 ? Math.round((blade.stamina / blade.maxStamina) * 100) : 0;
        return {
          action: "Faction Work (blade resting)",
          detail: `${repTarget.faction} (${type}) -> ${repTarget.aug} while stamina recovers (${stamina}%)`,
          bladePhase: "ops",
          target: repTarget,
          infra,
        };
      }
      this.releaseSlot();
    }

    return { ...this.bladeSummary(ns, blade), target, infra };
  }

  /**
   * The Bladeburner branch's gordState: what the action loop is doing and why.
   * `bladePhase` is the journal's identity for it - one line per change of
   * phase (contracts, a black op, a general fallback), not per contract switch.
   * @param {NS} ns @param {any} blade
   */
  bladeSummary(ns, blade) {
    const w = blade.want ?? {};
    const rank = ns.format.number(blade.rank ?? 0);
    const next = blade.nextBlackOp
      ? ` | next ${blade.nextBlackOp.name} @ ${ns.format.number(blade.nextBlackOp.rank)}`
      : blade.allBlackOpsDone ? " | all black ops done" : "";
    // Rest phases (Field Analysis / Recruitment / ...) come and go every few
    // minutes, so they belong to the "ops" phase rather than getting their own.
    const phase = w.type === "Black Operations" ? `blackop-${w.name}`
      : w.type === "General" && !blade.resting ? `general-${w.name}`
      : "ops";
    return {
      action: "Bladeburner",
      detail: `${w.name ?? "idle"} (${w.reason ?? ""}) | rank ${rank}${next}`,
      bladePhase: phase,
    };
  }

  /**
   * After the decision: the final slot answer for the action loop, and - once
   * every black op is done and the node may finish - the finisher in blade mode.
   * @param {NS} ns @param {any} _state
   */
  afterDecide(ns, _state) {
    this.publishControl(!this._slotClaimed);

    const blade = globalThis.gordBladeState;
    if (this._finishAllowed && blade?.allBlackOpsDone) {
      ensureHelper(ns, this.cfg.paths.finishBn, { args: [this.plannedNextBN(ns), this.cfg.paths.driver, "blade"] });
    }
  }

  /** Rank, stamina and skill points, plus the sleeve and gang rosters. @param {NS} ns */
  statusLine(ns) {
    const b = this.bladeState();
    const u = globalThis.gordBladeUpkeep;
    const bladeNote = b
      ? ` | Blade: rank ${ns.format.number(b.rank)}, stamina ${Math.round((b.stamina / Math.max(1, b.maxStamina)) * 100)}%` +
        `${u?.skillPoints != null ? `, ${u.skillPoints} SP` : ""}, ${b.action?.name ?? "idle"}`
      : ns.bladeburner.inBladeburner() ? " | Blade: action loop not running" : " | Blade: not joined";
    const s = globalThis.gordSleeveState;
    const sleeveNote = s?.mode === "blade"
      ? ` | Sleeves: ${s.bladeContracts ?? 0} on contracts, ${s.bladeInfiltrating ?? 0} infiltrating`
      : "";
    const gang = globalThis.gordGangState;
    const gangNote = gang ? ` | Gang: ${gang.members}/${gang.maxMembers} (${gang.faction})` : "";
    return bladeNote + sleeveNote + gangNote;
  }
}
