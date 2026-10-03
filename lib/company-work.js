// lib/company-work.js
//
// Megacorporation factions (ECorp, MegaCorp, ...): unlocked by holding a job at
// the company and grinding its reputation to the invite gate, not by city /
// backdoor / combat. Only nodes that opt in via factions.pursueCompanyFactions
// (BN10 today) ever do this - so the three Singularity calls it needs
// (getCompanyRep 1GB, applyToCompany 3GB, workForCompany 3GB) live here, in a
// module ONLY the opted-in daemon imports. Bitburner charges the API calls of
// every function reachable from main, so while this sat inside
// lib/player-actions.js / lib/aug-targets.js every daemon paid 7GB for a branch
// its node never took.
//
// Wiring: the daemon builds `makeCompanyWork(cfg)` and hands it to
// lib/daemon-core.js (hooks.companyWork); the core passes `opportunities` to
// getUnjoinedFactionOpportunities (which appends the company entries) and
// `pursue` to maybePursueNextFaction (which runs it as its last step).
//
// cfg is the NODE's config (forNode), which also fixes a latent bug: the old
// inline code read CONFIG.factions.companyWorkNeedsCity - the defaults - so
// BITNODE[10]'s override to true never applied.

import { CONFIG } from "./config.js";
import { factionHasUnownedAugs } from "./aug-targets.js";
import { focusFlag } from "./player-actions.js";

/**
 * @param {any} cfg  forNode(n) for the daemon's node
 * @returns {{opportunities: Function, pursue: Function}}
 */
export function makeCompanyWork(cfg) {
  const F = cfg.factions;
  if (!F.pursueCompanyFactions) return { opportunities: () => [], pursue: () => null };

  return {
    /**
     * Company-faction opportunities: one per opted-in faction we haven't joined
     * that still offers an aug we don't own ("add the corporation factions as a
     * next option if they have augs available"). Appended to the faction
     * pipeline by getUnjoinedFactionOpportunities. Singularity company work
     * isn't city-locked unless companyWorkNeedsCity says so, so these never
     * disturb the auto-travel loop on their own.
     * @param {NS} ns @param {{player: any, joined: Set<string>, invited: Set<string>}} c
     */
    opportunities(ns, { joined, invited }) {
      const s = ns.singularity;
      const owned = new Set(s.getOwnedAugmentations(true));
      const results = [];

      for (const factionName of [...F.priority, ...F.otherTracked]) {
        if (joined.has(factionName) || invited.has(factionName)) continue;
        const comp = F.companyFactions[factionName];
        if (!comp || !factionHasUnownedAugs(ns, factionName, owned)) continue;

        const repHave    = s.getCompanyRep(/** @type {any} */ (comp.company));
        const repReq     = F.companyRepReq;
        const repMissing = Math.max(0, repReq - repHave);
        results.push({
          faction: factionName,
          reason: repMissing > 0
            ? `Work ${comp.company} for rep (${Math.round(repHave).toLocaleString()}/${repReq.toLocaleString()})`
            : `${comp.company} rep met - awaiting invite`,
          urgency: repMissing > 0 ? "low" : "medium",
          invited: false,
          needsCity: false,
          city: null,
          needsBackdoor: false,
          backdoorServer: null,
          combatReqs: null,
          hackingFocus: false,
          needsCompany: true,
          company: comp.company,
          companyCity: comp.city,
          companyRepHave: repHave,
          companyRepReq: repReq,
          companyRepMissing: repMissing,
        });
      }
      return results;
    },

    /**
     * Work the highest-priority company faction still short of its rep gate.
     * The game auto-invites at the gate and acceptInvites() joins, after which
     * the faction's augs flow into the normal aug pipeline. Returns a status
     * object, or null when there's nothing to do.
     * @param {NS} ns @param {any[]} opportunities @param {any} player
     */
    pursue(ns, opportunities, player) {
      const s = ns.singularity;
      const op = opportunities.find(o => o.needsCompany && o.companyRepMissing > 0);
      if (!op) return null;

      // City-locked builds: get to the company's city first. The daemon publishes
      // companyCity as globalThis.gordCompanyCity whenever this is the active
      // action, which stops maybeAutoTravelForReadyFaction from pulling us home.
      if (F.companyWorkNeedsCity && player.city !== op.companyCity) {
        if (player.money < CONFIG.player.travelCost) return null;
        s.travelToCity(/** @type {any} */ (op.companyCity));
        return {
          action: "Company Work",
          detail: `-> ${op.companyCity} for ${op.company} rep -> ${op.faction}`,
          faction: op.faction,
          company: op.company,
          companyCity: op.companyCity,
        };
      }

      const field = applyBestCompanyJob(ns, op.company, F.companyFieldPriority);
      // workForCompany THROWS when we hold no job there - and we won't until we
      // qualify for an entry position (ECorp wants ~250 hacking), and never right
      // after an install, which clears every job.
      const employed = !!(ns.getPlayer().jobs ?? {})[op.company];
      if (employed && s.workForCompany(/** @type {any} */ (op.company), focusFlag(ns))) {
        return {
          action: "Company Work",
          detail: `${op.company} (${field ?? "employed"}) rep ${Math.round(op.companyRepHave).toLocaleString()}/${op.companyRepReq.toLocaleString()} -> ${op.faction}`,
          faction: op.faction,
          company: op.company,
          companyCity: op.companyCity,
        };
      }
      return null;
    },
  };
}

/**
 * Make sure we hold the best-paying job we qualify for at `company`, so
 * workForCompany earns rep as fast as possible. Applies to each field in
 * priority order and takes the first that yields a position (applyToCompany
 * also auto-promotes us as our stats grow). Returns the field we applied under,
 * or null if we're already at the best position everywhere (or don't yet
 * qualify for any) - workForCompany still runs in that case.
 * @param {NS} ns @param {string} company @param {string[]} fields
 */
function applyBestCompanyJob(ns, company, fields) {
  const s = ns.singularity;
  // Stay on the track we're on: applyToCompany hands out the ENTRY job of any
  // field we newly qualify for, so walking the whole list every tick flipped the
  // job between tracks (Software <-> Business) once charisma caught up, losing
  // the promotions earned on the first. Re-applying to our own field is how a
  // promotion is claimed.
  const employed = !!(ns.getPlayer().jobs ?? {})[company];
  const mine = employed ? _fieldAt.get(company) : null;
  for (const field of mine ? [mine] : fields) {
    const job = s.applyToCompany(/** @type {any} */ (company), /** @type {any} */ (field));
    if (job) {
      _fieldAt.set(company, field);
      return field;
    }
  }
  return mine ?? null;
}

/** company -> the field we were hired under (this process's memory). */
const _fieldAt = new Map();
