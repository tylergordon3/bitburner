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

// Combat/gang factions with join requirements we can work toward, but which
// aren't part of FACTION_PRIORITY's endgame-aug ordering. Scanned separately
// in getUnjoinedFactionOpportunities so they aren't silently skipped.
export const OTHER_TRACKED_FACTIONS = [
  "Slum Snakes",
  "Tetrads",
  "Speakers for the Dead",
  "The Dark Army",
  "The Syndicate",
];

// Hacking-oriented factions - reachable via hacking level/backdoors rather
// than combat grinding. We're playing BN4 (Singularity), where hacking augs
// and hacking-based income/rep dominate, so these get first pick whenever
// multiple faction opportunities are simultaneously viable.
export const HACKING_FACTIONS = new Set([
  "CyberSec",
  "NiteSec",
  "The Black Hand",
  "BitRunners",
  "Tian Di Hui",
  "Netburners",
]);

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

// Money required to *join* a faction (on top of other requirements).
// Only list factions where this is a meaningful gate.
// Verified against Bitburner's FactionInfo.tsx inviteReqs - Speakers for the
// Dead, The Dark Army, and Tetrads have NO money requirement (they were
// wrongly listed here before); Slum Snakes does ($1M) and wasn't tracked.
export const FACTION_JOIN_MONEY = {
  "Tian Di Hui":            1_000_000,
  "The Syndicate":          10_000_000,
  "Slum Snakes":            1_000_000,
  "Sector-12":              15_000_000,
  "Aevum":                  40_000_000,
  "Chongqing":              20_000_000,
  "New Tokyo":              20_000_000,
  "Ishima":                 30_000_000,
  "Volhaven":               50_000_000,
};

// Factions that require visiting one of a set of cities (any one qualifies).
// Verified against FactionInfo.tsx: Tian Di Hui and Tetrads accept Chongqing,
// New Tokyo, OR Ishima; The Syndicate accepts Aevum OR Sector-12; The Dark
// Army requires Chongqing specifically. Speakers for the Dead has NO city
// requirement at all (previously wrongly mapped to Volhaven here).
export const FACTION_CITY = {
  "Tian Di Hui":   ["Chongqing", "New Tokyo", "Ishima"],
  "The Syndicate": ["Aevum", "Sector-12"],
  "The Dark Army": ["Chongqing"],
  "Tetrads":       ["Chongqing", "New Tokyo", "Ishima"],
  "Netburners":    null, // no city req, but hacknet-based
};

// Non-combat, non-money gates for gang/criminal factions, verified against
// FactionInfo.tsx inviteReqs. karma is a ceiling (player.karma must be <= the
// value, since more negative = eviler); hacking/kills are floors. Not tracked:
// "not employed by CIA/NSA" (Speakers for the Dead, The Dark Army, The
// Syndicate) - rarely relevant since the bot never takes those jobs.
export const FACTION_EXTRA_REQUIREMENTS = {
  "Slum Snakes":           { karma: -9 },
  "Tetrads":               { karma: -18 },
  "The Syndicate":         { hacking: 200, karma: -90 },
  "Speakers for the Dead": { hacking: 100, karma: -45, kills: 30 },
  "The Dark Army":         { hacking: 300, karma: -45, kills: 5 },
};

// Factions that need a server backdoor before you can join.
export const FACTION_BACKDOOR = {
  "CyberSec":      "CSEC",
  "NiteSec":       "avmnite-02h",
  "The Black Hand": "I.I.I.I",
  "BitRunners":    "run4theh111z",
};

// City-faction mutual exclusivity: joining a city faction permanently bans its
// "enemies" from ever being joined for the rest of this reset (Bitburner's
// FactionInfo.tsx `enemies` lists). Sector-12 and Aevum are NOT enemies of each
// other, but Volhaven is an enemy of every other city faction, and Chongqing /
// New Tokyo / Ishima are each enemies with Sector-12, Aevum, and Volhaven (but
// not with each other).
export const CITY_FACTION_ENEMIES = {
  "Sector-12": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
  "Aevum":     ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
  "Chongqing": ["Sector-12", "Aevum", "Volhaven"],
  "New Tokyo": ["Sector-12", "Aevum", "Volhaven"],
  "Ishima":    ["Sector-12", "Aevum", "Volhaven"],
  "Volhaven":  ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima"],
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

/**
 * True if `factionName` still offers at least one augmentation (other than
 * NeuroFlux Governor) that isn't already owned.
 * @param {NS} ns
 * @param {string} factionName
 * @param {Set<string>} owned
 */
function factionHasUnownedAugs(ns, factionName, owned) {
  return ns.singularity
    .getAugmentationsFromFaction(/** @type {any} */ (factionName))
    .some(aug => aug !== "NeuroFlux Governor" && !owned.has(aug));
}

/**
 * Decide whether it's safe to accept an invite to a city faction right now.
 *
 * Joining a city faction permanently bans its CITY_FACTION_ENEMIES for the
 * rest of the run, so we hold off when:
 *  - the faction has nothing left to offer (no unowned augs) - joining would
 *    only burn the ban for no benefit, or
 *  - joining would ban an enemy city faction we haven't joined yet that still
 *    has augs we want - better to stay flexible and go collect those first.
 *
 * Non-city factions always return true (no exclusivity to worry about).
 * @param {NS} ns
 * @param {string} factionName
 */
export function shouldJoinCityFaction(ns, factionName) {
  const enemies = CITY_FACTION_ENEMIES[factionName];
  if (!enemies) return true;

  const owned  = new Set(ns.singularity.getOwnedAugmentations(true));
  const joined = new Set(/** @type {string[]} */ (ns.getPlayer().factions ?? []));

  if (!factionHasUnownedAugs(ns, factionName, owned)) return false;

  for (const enemy of enemies) {
    if (joined.has(enemy)) continue;
    if (factionHasUnownedAugs(ns, enemy, owned)) return false;
  }

  return true;
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
 * Check the non-combat, non-money gates for a faction (see
 * FACTION_EXTRA_REQUIREMENTS): karma ceiling, hacking/kill floors.
 * Returns { met, reasons } where reasons are short human-readable gap strings.
 * @param {NS} ns
 * @param {string} factionName
 * @param {any} player
 */
function getExtraRequirementGaps(ns, factionName, player) {
  const extra = FACTION_EXTRA_REQUIREMENTS[factionName];
  if (!extra) return { met: true, reasons: [] };

  const reasons = [];

  if (extra.hacking != null) {
    const have = player.skills?.hacking ?? ns.getHackingLevel();
    if (have < extra.hacking) reasons.push(`hack ${have}/${extra.hacking}`);
  }
  if (extra.kills != null) {
    const have = player.numPeopleKilled ?? 0;
    if (have < extra.kills) reasons.push(`kills ${have}/${extra.kills}`);
  }
  if (extra.karma != null) {
    const have = player.karma ?? 0;
    if (have > extra.karma) reasons.push(`karma ${have.toFixed(0)}/${extra.karma}`);
  }

  return { met: reasons.length === 0, reasons };
}

/**
 * Return factions we haven't joined yet that are reachable and worth
 * pursuing. Used by daemon.js to schedule "next faction" work.
 *
 * Returns objects: { faction, reason, urgency, missingRep, missingMoney,
 *                    needsCity, city, needsBackdoor, backdoorServer,
 *                    combatReqs, extraGaps, hackingFocus }
 * hackingFocus marks factions reachable via hacking/backdoor rather than
 * combat grinding - BN4 is hacking-centric, so callers should prefer these.
 *
 * @param {NS} ns
 */
export function getUnjoinedFactionOpportunities(ns) {
  const s = ns.singularity;
  const player = ns.getPlayer();
  const joined  = /** @type {Set<string>} */ (new Set(player.factions ?? []));
  const invited = /** @type {Set<string>} */ (new Set(s.checkFactionInvitations()));

  const results = [];

  for (const factionName of [...FACTION_PRIORITY, ...OTHER_TRACKED_FACTIONS]) {
    if (joined.has(factionName)) continue;

    const cityOptions = FACTION_CITY[factionName] ?? null;
    const bdServer   = FACTION_BACKDOOR[factionName] ?? null;
    const combatReqs = FACTION_REQUIREMENTS[factionName] ?? null;
    const hackingFocus = HACKING_FACTIONS.has(factionName);

    // Check if invited — easiest case, daemon handles auto-join already
    if (invited.has(factionName)) {
      results.push({
        faction: factionName,
        reason:  "Invited - join pending",
        urgency: "high",
        invited: true,
        needsCity: false,
        city: null,
        needsBackdoor: false,
        backdoorServer: null,
        combatReqs: null,
        hackingFocus,
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
          hackingFocus,
        });
      }
      continue;
    }

    // City-gated factions - pick whichever accepted city we're already in,
    // else default to the first option in the list.
    if (cityOptions) {
      const currentCity = player.city;
      const city = cityOptions.includes(currentCity) ? currentCity : cityOptions[0];

      // Some city factions (Tetrads, The Dark Army, The Syndicate) also gate
      // on combat stats. Powerhouse Gym only exists in Sector-12, so these
      // must be trained up before traveling - factor that into canTravel so
      // we don't strand ourselves in a city with no gym access.
      const skills = player.skills ?? {};
      const statGaps = {};
      let maxGap = 0;
      if (combatReqs) {
        for (const [stat, needed] of Object.entries(combatReqs)) {
          const have = skills[stat] ?? 0;
          const gap  = Math.max(0, needed - have);
          statGaps[stat] = { have, needed, gap };
          if (gap > maxGap) maxGap = gap;
        }
      }
      const statsMet = maxGap === 0;
      const isClose  = !statsMet && Object.values(statGaps).every(g => g.gap <= 50);

      const joinMoneyReq = FACTION_JOIN_MONEY[factionName] ?? 0;
      const joinMoneyMissing = Math.max(0, joinMoneyReq - player.money);
      const extraGaps = getExtraRequirementGaps(ns, factionName, player);
      // canTravel = can afford the $200k trip, meets the join money req,
      // meets any karma/kill/hacking gates, AND meets combat stats (if any).
      const canTravel = player.money >= 200_000 && joinMoneyMissing <= 0 && extraGaps.met && statsMet;

      const reasonParts = [];
      if (!statsMet) reasonParts.push(`Combat stats needed (max gap: ${maxGap})`);
      if (joinMoneyMissing > 0) reasonParts.push(`Need $${(joinMoneyReq / 1e6).toFixed(1)}M`);
      reasonParts.push(...extraGaps.reasons);
      const reason = reasonParts.length > 0
        ? `${reasonParts.join(", ")} to join ${factionName}`
        : `Travel to ${city}`;

      // Non-combat city factions (e.g. Tian Di Hui) stay "low" priority while
      // blocked rather than dropping to "future" - only demote to "future"
      // when there's an actual stat gap that isn't close yet.
      const urgency = canTravel ? "medium" : (combatReqs && !isClose) ? "future" : "low";

      results.push({
        faction: factionName,
        reason,
        urgency,
        invited: false,
        needsCity: true,
        city,
        cityOptions,
        currentCity,
        canTravel,
        joinMoneyMissing,
        extraGaps: extraGaps.reasons,
        needsBackdoor: false,
        backdoorServer: null,
        combatReqs: combatReqs ?? null,
        statGaps,
        allStatsMet: statsMet,
        isClose,
        hackingFocus,
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

      const statsMet = maxGap === 0;
      // "Close" means within 50 levels on every stat
      const isClose = !statsMet && Object.values(statGaps).every(g => g.gap <= 50);

      const joinMoneyReq = FACTION_JOIN_MONEY[factionName] ?? 0;
      const joinMoneyMissing = Math.max(0, joinMoneyReq - player.money);
      const extraGaps = getExtraRequirementGaps(ns, factionName, player);
      const allMet = statsMet && joinMoneyMissing <= 0 && extraGaps.met;

      const reasonParts = [];
      if (!statsMet) reasonParts.push(`Combat stats needed (max gap: ${maxGap})`);
      if (joinMoneyMissing > 0) reasonParts.push(`Need $${(joinMoneyReq / 1e6).toFixed(1)}M`);
      reasonParts.push(...extraGaps.reasons);
      const reason = reasonParts.length > 0 ? reasonParts.join(" | ") : "Stats met - check invite";

      results.push({
        faction: factionName,
        reason,
        urgency: allMet ? "medium" : (statsMet || isClose) ? "low" : "future",
        invited: false,
        needsCity: false,
        city: null,
        needsBackdoor: false,
        backdoorServer: null,
        combatReqs,
        statGaps,
        joinMoneyMissing,
        extraGaps: extraGaps.reasons,
        allStatsMet: statsMet,
        allRequirementsMet: allMet,
        isClose,
        hackingFocus,
      });
      continue;
    }
  }

  return results;
}