// lib/aug-targets.js
//
// Aug/faction targeting logic. The reference tables it works from (priority
// order, join requirements, city gates, backdoor gates, enemy lists) live in
// CONFIG.factions - see lib/config.js. Consumers that need those tables should
// import CONFIG directly rather than going through this module, which carries
// Singularity calls.

import { CONFIG, forNode } from "./config.js";

const F = CONFIG.factions;
const A = CONFIG.augs;

const FACTION_PRIORITY = F.priority;

// Hacking-oriented factions - reachable via hacking level/backdoors rather than
// combat grinding. These get first pick whenever multiple faction opportunities
// are simultaneously viable.
const HACKING_FACTIONS = new Set(F.hackingFocused);

// ── Rate helpers ─────────────────────────────────────────────────────────────

/**
 * Pull income rate ($/ms) from the rolling snapshot in daemon.js.
 * Falls back to 0 if not yet available.
 */
function incomeRatePerMs() {
  const snap = globalThis._incomeSnap;
  if (!snap) return 0;
  const elapsed = Date.now() - snap.time;
  if (elapsed < CONFIG.player.incomeSnapshotMs) return 0;
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
    .some(aug => aug !== A.neuroFlux && !owned.has(aug));
}

/**
 * How many augmentations (excluding NeuroFlux) `factionName` still has that we
 * don't own - the crude "what's this faction worth to us" score.
 * @param {NS} ns @param {string} factionName @param {Set<string>} owned
 */
function countUnownedAugs(ns, factionName, owned) {
  return ns.singularity
    .getAugmentationsFromFaction(/** @type {any} */ (factionName))
    .filter(aug => aug !== A.neuroFlux && !owned.has(aug))
    .length;
}

/**
 * Decide whether to accept an invite to a city faction right now.
 *
 * Joining one permanently bans its enemies (CONFIG.factions.cityEnemies) for the
 * rest of the run, so this used to hold off whenever ANY unjoined enemy still had
 * augs we wanted. That's a deadlock: early in a run every city faction has unowned
 * augs, and the city factions are enemies of each other, so each one was declined
 * on account of the others and we never joined a single one all run.
 *
 * The real question is only ever "is a BETTER city faction actually available right
 * now?", so we decline only when:
 *  - this faction has nothing left to offer (no unowned augs) - joining would burn
 *    the ban for no benefit, or
 *  - an enemy city faction has a PENDING INVITE this very tick and offers strictly
 *    more unowned augs - take that one instead.
 * Ties and hypotheticals go to joining: a faction in hand beats one we might get
 * invited to eventually.
 *
 * Non-city factions always return true (no exclusivity to worry about).
 * @param {NS} ns
 * @param {string} factionName
 * @param {string[]} [pendingInvites] - the other invites open right now
 */
export function shouldJoinCityFaction(ns, factionName, pendingInvites = []) {
  const enemies = F.cityEnemies[factionName];
  if (!enemies) return true;

  const owned = new Set(ns.singularity.getOwnedAugmentations(true));

  const mine = countUnownedAugs(ns, factionName, owned);
  if (mine === 0) return false;

  return !pendingInvites.some(other =>
    other !== factionName &&
    enemies.includes(other) &&
    countUnownedAugs(ns, other, owned) > mine
  );
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
      if (aug === A.neuroFlux) continue;
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
      const pa = a.priorityIndex === -1 ? A.unknownPriorityIndex : a.priorityIndex;
      const pb = b.priorityIndex === -1 ? A.unknownPriorityIndex : b.priorityIndex;
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
    if (Math.abs(diff) / Math.max(a.estimatedMs, 1) > A.estimateTieTolerance) return diff;

    // Within 10% — prefer faction priority
    const pa = a.priorityIndex === -1 ? A.unknownPriorityIndex : a.priorityIndex;
    const pb = b.priorityIndex === -1 ? A.unknownPriorityIndex : b.priorityIndex;
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
 * Evaluate one PlayerRequirement (from getFactionInviteRequirements) against the
 * player. Returns true (met), false (unmet), or null (a requirement type we don't
 * model - treated as "can't confirm", so the caller stays conservative).
 * @param {any} req @param {any} ctx
 */
function evalRequirement(req, ctx) {
  switch (req.type) {
    case "money": return ctx.money >= req.money;
    case "skills": return Object.entries(req.skills).every(([k, v]) => (ctx.skills[k] ?? 0) >= Number(v));
    case "numAugmentations": return ctx.installedAugs >= req.numAugmentations;
    case "karma": return (ctx.karma ?? 0) <= req.karma;
    case "numPeopleKilled": return (ctx.kills ?? 0) >= req.numPeopleKilled;
    case "city": return ctx.city === req.city;
    case "backdoorInstalled": return ctx.backdoor(req.server);
    case "not": {
      const r = evalRequirement(req.condition, ctx);
      return r === null ? null : !r;
    }
    case "someCondition": {
      const rs = req.conditions.map(c => evalRequirement(c, ctx));
      if (rs.some(x => x === true)) return true;
      return rs.some(x => x === null) ? null : false;
    }
    case "everyCondition": {
      const rs = req.conditions.map(c => evalRequirement(c, ctx));
      if (rs.some(x => x === false)) return false;
      return rs.some(x => x === null) ? null : true;
    }
    default: return null; // unmodelled requirement type
  }
}

/**
 * Find the cheapest un-joined faction whose ONLY unmet invite requirement is
 * money (e.g. Daedalus / The Covenant / Illuminati - big cash gates you must
 * momentarily hold). Returns { faction, money, moneyMissing } or null.
 *
 * The daemon uses this to switch into "hoard" mode: stop spending and hold cash
 * until the invite fires. Requirements are read live via getFactionInviteRequirements
 * so BitNode multipliers are honoured, and every non-money requirement must be
 * confirmably met (an unmodelled requirement type disqualifies the faction, so we
 * never hoard for something we can't actually complete).
 * @param {NS} ns
 */
export function getMoneyHoardGoal(ns) {
  if (!F.hoardMoneyGatedInvites) return null;

  const s = ns.singularity;
  const player = ns.getPlayer();
  const joined = /** @type {Set<string>} */ (new Set(player.factions ?? []));

  const ctx = {
    money: player.money,
    skills: player.skills ?? {},
    installedAugs: s.getOwnedAugmentations(false).length,
    karma: player.karma ?? 0,
    kills: player.numPeopleKilled ?? 0,
    city: player.city,
    backdoor: (server) => {
      try { return ns.serverExists(server) && ns.getServer(server).backdoorInstalled === true; }
      catch { return false; }
    },
  };

  let best = /** @type {{ faction: string, money: number, moneyMissing: number } | null} */ (null);
  for (const faction of FACTION_PRIORITY) {
    if (joined.has(faction)) continue;

    // Cast to any[]: PlayerRequirement is a discriminated union, and reading
    // member-specific fields (.money, .conditions) off it otherwise trips checkJs.
    let reqs = /** @type {any[]} */ (null);
    try { reqs = /** @type {any} */ (s.getFactionInviteRequirements(/** @type {any} */ (faction))); }
    catch { continue; }
    if (!reqs || !reqs.length) continue;

    const moneyReqs = reqs.filter(r => r.type === "money");
    if (!moneyReqs.length) continue;
    const money = Math.max(...moneyReqs.map(r => r.money));
    if (money < F.minHoardMoney) continue;              // trivial money gate - ignore

    // Every non-money requirement must be confirmably met.
    const others = reqs.filter(r => r.type !== "money");
    if (!others.every(r => evalRequirement(r, ctx) === true)) continue;

    const moneyMissing = money - ctx.money;
    if (moneyMissing <= 0) continue;                    // already hold it - invite will fire

    if (!best || money < best.money) best = { faction, money, moneyMissing };
  }
  return best;
}

/**
 * Check the non-combat, non-money gates for a faction (see
 * CONFIG.factions.extraRequirements): karma ceiling, hacking/kill floors.
 * Returns { met, reasons } where reasons are short human-readable gap strings.
 * @param {NS} ns
 * @param {string} factionName
 * @param {any} player
 */
function getExtraRequirementGaps(ns, factionName, player) {
  const extra = F.extraRequirements[factionName];
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

  // Company (megacorp) factions are only pursued on nodes that opt in - see
  // CONFIG.factions.pursueCompanyFactions / BITNODE. When on, we need the owned-aug
  // set to honour "only if they have augs available"; skip building it otherwise so
  // this stays as cheap as before for every other node.
  const pursueCompany = forNode(ns.getResetInfo().currentNode).factions.pursueCompanyFactions;
  const ownedForCompany = pursueCompany
    ? new Set(s.getOwnedAugmentations(true))
    : null;

  const results = [];

  for (const factionName of [...FACTION_PRIORITY, ...F.otherTracked]) {
    if (joined.has(factionName)) continue;

    const cityOptions = F.city[factionName] ?? null;
    const bdServer   = F.backdoor[factionName] ?? null;
    const combatReqs = F.requirements[factionName] ?? null;
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
      const isClose  = !statsMet && Object.values(statGaps).every(g => g.gap <= CONFIG.player.closeStatGap);

      const joinMoneyReq = F.joinMoney[factionName] ?? 0;
      const joinMoneyMissing = Math.max(0, joinMoneyReq - player.money);
      const extraGaps = getExtraRequirementGaps(ns, factionName, player);
      // canTravel = can afford the $200k trip, meets the join money req,
      // meets any karma/kill/hacking gates, AND meets combat stats (if any).
      const canTravel = player.money >= CONFIG.player.travelCost && joinMoneyMissing <= 0 && extraGaps.met && statsMet;

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
      const isClose = !statsMet && Object.values(statGaps).every(g => g.gap <= CONFIG.player.closeStatGap);

      const joinMoneyReq = F.joinMoney[factionName] ?? 0;
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

    // Company-reputation-gated factions (megacorps). Only when this node opts in,
    // and only while the faction still offers an aug we don't own ("add the
    // corporation factions as a next option if they have augs available"). These
    // don't use travel/backdoor/combat - the daemon just works the company for
    // rep from wherever it is (Singularity company work isn't city-locked), so we
    // leave needsCity/canTravel false and they never disturb the auto-travel loop.
    if (pursueCompany) {
      const comp = F.companyFactions[factionName];
      if (comp && ownedForCompany && factionHasUnownedAugs(ns, factionName, ownedForCompany)) {
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
    }
  }

  return results;
}