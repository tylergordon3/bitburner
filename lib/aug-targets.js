// lib/aug-targets.js

export const FACTION_PRIORITY = [
  "Illuminati",
  "Daedalus",
  "The Covenant",
  "BitRunners",
  "ECorp",
  "MegaCorp",
  "Bachman & Associates",
  "Blade Industries",
  "NWO",
  "Clarke Incorporated",
  "OmniTek Incorporated",
  "Four Sigma",
  "KuaiGong International",
  "Fulcrum Secret Technologies",
  "CyberSec",
  "Tian Di Hui",
  "Netburners",
  "NiteSec",
  "The Black Hand",
];

export const FACTION_REQUIREMENTS = {
  "Slum Snakes": {
    strength: 30,
    defense: 30,
    dexterity: 30,
    agility: 30,
  },
  "Tetrads": {
    strength: 75,
    defense: 75,
    dexterity: 75,
    agility: 75,
  },
  "Speakers for the Dead": {
    strength: 300,
    defense: 300,
    dexterity: 300,
    agility: 300,
  },
  "The Dark Army": {
    strength: 300,
    defense: 300,
    dexterity: 300,
    agility: 300,
  },
  "The Syndicate": {
    strength: 200,
    defense: 200,
    dexterity: 200,
    agility: 200,
  },
};

// Factions that require visiting a specific city.
export const FACTION_CITY = {
  "Tian Di Hui":        "Chongqing",
  "The Syndicate":      "Aevum",
  "Speakers for the Dead": "Volhaven",
  "The Dark Army":      "Chongqing",
  "Tetrads":            "Ishima",
  "Netburners":         null, // no city req, but hacknet-based
};

// Factions that need a server backdoor before you can join.
export const FACTION_BACKDOOR = {
  "CyberSec":      "CSEC",
  "NiteSec":       "avmnite-02h",
  "The Black Hand": "I.I.I.I",
  "BitRunners":    "run4theh111z",
};

// ── Rate helpers ─────────────────────────────────────────────────────────────

/**
 * Pull income rate ($/ms) from the rolling snapshot in daemon.js.
 * Falls back to 0 if not yet available.
 */
function incomeRatePerMs() {
  const snap = globalThis._incomeSnap;
  if (!snap) return 0;
  const elapsed = Date.now() - snap.time;
  if (elapsed < 5_000) return 0;
  // snap.money is the money AT the time of the snapshot; we can't derive
  // rate from a single point, so we use the stored derived rate if present.
  return globalThis._incomeRatePerMs ?? 0;
}

/**
 * Pull faction rep rate (rep/ms) for a specific faction from a rolling
 * snapshot stored by daemon.js.
 */
function repRatePerMs(faction) {
  const snaps = globalThis._repSnaps ?? {};
  const snap = snaps[faction];
  if (!snap || !snap.rate) return 0;
  return snap.rate;
}

/**
 * Estimate wall-clock milliseconds needed to acquire an aug from scratch.
 *
 * Uses:
 *  - repMissing / repRate  (if rep still needed, this dominates)
 *  - moneyMissing / moneyRate
 *
 * Returns Infinity when rates are unknown.
 */
function estimateTimeMs(repMissing, moneyMissing, faction) {
  const rr = repRatePerMs(faction);
  const mr = incomeRatePerMs();

  const repMs   = repMissing  <= 0 ? 0 : rr > 0 ? repMissing  / rr : Infinity;
  const moneyMs = moneyMissing <= 0 ? 0 : mr > 0 ? moneyMissing / mr : Infinity;

  // Rep and money can be earned in parallel (hacking earns money AND rep),
  // so the bottleneck is the larger of the two.
  return Math.max(repMs, moneyMs);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Return ALL purchasable aug candidates across every joined faction,
 * sorted by estimated time-to-purchase (soonest first).
 *
 * Each entry: { faction, aug, repReq, rep, price, repMissing, moneyMissing,
 *               canBuy, estimatedMs, priorityIndex }
 *
 * @param {NS} ns
 */
export function getAllAugCandidates(ns) {
  const s = ns.singularity;
  const player = ns.getPlayer();

  const owned    = new Set(s.getOwnedAugmentations(true));
  const installed = new Set(s.getOwnedAugmentations(false));
  const joined   = /** @type {string[]} */ (player.factions ?? []);

  const candidates = [];

  for (const factionName of joined) {
    const faction = /** @type {any} */ (factionName);
    const rep = s.getFactionRep(faction);

    for (const aug of s.getAugmentationsFromFaction(faction)) {
      if (aug === "NeuroFlux Governor") continue;
      if (owned.has(aug)) continue;

      const prereqs = s.getAugmentationPrereq(aug);
      if (!prereqs.every(a => owned.has(a) || installed.has(a))) continue;

      const repReq  = s.getAugmentationRepReq(aug);
      const price   = s.getAugmentationPrice(aug);

      const repMissing   = Math.max(0, repReq - rep);
      const moneyMissing = Math.max(0, price - player.money);
      const canBuy       = repMissing <= 0 && moneyMissing <= 0;

      const priorityIndex = FACTION_PRIORITY.indexOf(factionName);

      const estimatedMs = canBuy
        ? 0
        : estimateTimeMs(repMissing, moneyMissing, factionName);

      candidates.push({
        faction: factionName,
        aug,
        repReq,
        rep,
        price,
        repMissing,
        moneyMissing,
        canBuy,
        estimatedMs,
        priorityIndex,
      });
    }
  }

  // Sort: canBuy first, then by estimated time, then by faction priority as
  // a tiebreaker when rates are unknown (Infinity).
  candidates.sort((a, b) => {
    if (a.canBuy !== b.canBuy) return a.canBuy ? -1 : 1;

    // Both unknown-rate → fall back to faction priority + price
    if (!isFinite(a.estimatedMs) && !isFinite(b.estimatedMs)) {
      const pa = a.priorityIndex === -1 ? 99 : a.priorityIndex;
      const pb = b.priorityIndex === -1 ? 99 : b.priorityIndex;
      if (pa !== pb) return pa - pb;
      // Prefer lower rep requirement (closer to achievable)
      if (a.repMissing !== b.repMissing) return a.repMissing - b.repMissing;
      return a.price - b.price;
    }

    if (!isFinite(a.estimatedMs)) return 1;
    if (!isFinite(b.estimatedMs)) return -1;

    // Both have rate data — pick faster one, with a 10% tolerance so we
    // don't thrash between nearly-equal options.
    const diff = a.estimatedMs - b.estimatedMs;
    if (Math.abs(diff) / Math.max(a.estimatedMs, 1) > 0.10) return diff;

    // Within 10% — prefer faction priority
    const pa = a.priorityIndex === -1 ? 99 : a.priorityIndex;
    const pb = b.priorityIndex === -1 ? 99 : b.priorityIndex;
    return pa - pb;
  });

  return candidates;
}

/**
 * Return the single best aug target to work toward right now.
 * This is always the first entry of getAllAugCandidates().
 *
 * @param {NS} ns
 */
export function getNextAugTarget(ns) {
  const candidates = getAllAugCandidates(ns);
  return candidates[0] ?? null;
}

/**
 * Return factions we haven't joined yet that are reachable and worth
 * pursuing. Used by daemon.js to schedule "next faction" work.
 *
 * Returns objects: { faction, reason, urgency, missingRep, missingMoney,
 *                    needsCity, city, needsBackdoor, backdoorServer,
 *                    combatReqs }
 *
 * @param {NS} ns
 */
export function getUnjoinedFactionOpportunities(ns) {
  const s = ns.singularity;
  const player = ns.getPlayer();
  const joined  = /** @type {Set<string>} */ (new Set(player.factions ?? []));
  const invited = /** @type {Set<string>} */ (new Set(s.checkFactionInvitations()));

  const results = [];

  for (const factionName of FACTION_PRIORITY) {
    if (joined.has(factionName)) continue;

    const city       = FACTION_CITY[factionName] ?? null;
    const bdServer   = FACTION_BACKDOOR[factionName] ?? null;
    const combatReqs = FACTION_REQUIREMENTS[factionName] ?? null;

    // Check if invited — easiest case, daemon handles auto-join already
    if (invited.has(factionName)) {
      results.push({
        faction: factionName,
        reason:  "Invited — join pending",
        urgency: "high",
        invited: true,
        needsCity: false,
        city: null,
        needsBackdoor: false,
        backdoorServer: null,
        combatReqs: null,
      });
      continue;
    }

    // Backdoor-gated factions
    if (bdServer) {
      const serverExists  = ns.serverExists(bdServer);
      const hasRoot       = serverExists && ns.hasRootAccess(bdServer);
      const backdoorDone  = serverExists && ns.getServer(bdServer).backdoorInstalled;
      const hackOk        = serverExists && ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(bdServer);

      if (!backdoorDone) {
        results.push({
          faction: factionName,
          reason:  backdoorDone ? "Backdoor done" : hasRoot && hackOk ? "Ready to backdoor" : `Need backdoor on ${bdServer}`,
          urgency: hasRoot && hackOk ? "medium" : "low",
          invited: false,
          needsCity: false,
          city: null,
          needsBackdoor: true,
          backdoorServer: bdServer,
          hasRoot,
          hackOk,
          combatReqs: null,
        });
      }
      continue;
    }

    // City-gated factions
    if (city) {
      const currentCity = player.city;
      const canTravel   = player.money >= 200_000; // travel cost

      results.push({
        faction: factionName,
        reason:  `Travel to ${city}`,
        urgency: canTravel ? "medium" : "low",
        invited: false,
        needsCity: true,
        city,
        currentCity,
        canTravel,
        needsBackdoor: false,
        backdoorServer: null,
        combatReqs: combatReqs ?? null,
      });
      continue;
    }

    // Combat-stat-gated factions (Slum Snakes, Tetrads, etc.)
    if (combatReqs) {
      const skills = player.skills ?? {};
      const statGaps = {};
      let maxGap = 0;

      for (const [stat, needed] of Object.entries(combatReqs)) {
        const have = skills[stat] ?? 0;
        const gap  = Math.max(0, needed - have);
        statGaps[stat] = { have, needed, gap };
        if (gap > maxGap) maxGap = gap;
      }

      const allMet = maxGap === 0;
      // "Close" means within 50 levels on every stat
      const isClose = !allMet && Object.values(statGaps).every(g => g.gap <= 50);

      results.push({
        faction: factionName,
        reason:  allMet ? "Stats met — check invite" : `Combat stats needed (max gap: ${maxGap})`,
        urgency: allMet ? "medium" : isClose ? "low" : "future",
        invited: false,
        needsCity: false,
        city: null,
        needsBackdoor: false,
        backdoorServer: null,
        combatReqs,
        statGaps,
        allStatsMet: allMet,
        isClose,
      });
      continue;
    }
  }

  return results;
}