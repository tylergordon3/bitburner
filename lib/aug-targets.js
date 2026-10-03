// lib/aug-targets.js
//
// Aug/faction targeting logic. The reference tables it works from (priority
// order, join requirements, city gates, backdoor gates, enemy lists) live in
// CONFIG.factions - see lib/config.js. Consumers that need those tables should
// import CONFIG directly rather than going through this module, which carries
// Singularity calls.

import { CONFIG } from "./config.js";

const F = CONFIG.factions;
const A = CONFIG.augs;

const FACTION_PRIORITY = F.priority;

// Hacking-oriented factions - reachable via hacking level/backdoors rather than
// combat grinding. These get first pick whenever multiple faction opportunities
// are simultaneously viable.
const HACKING_FACTIONS = new Set(F.hackingFocused);

/**
 * Is `server` backdoored? Read from the state lib/backdoor.js publishes rather
 * than ns.getServer (2GB on every daemon for one boolean): the helper is what
 * installs backdoors, so it's the authority, and it runs from the daemon's first
 * tick. Until it has published (or if it can't be placed) this reads false,
 * which only ever delays a "ready to join" by a tick or two.
 * @param {NS} ns @param {string} server
 */
function backdoorDone(ns, server) {
  if (!ns.serverExists(server)) return false;
  return (globalThis.gordBackdoorState?.done ?? []).includes(server);
}

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
export function factionHasUnownedAugs(ns, factionName, owned) {
  return ns.singularity
    .getAugmentationsFromFaction(/** @type {any} */ (factionName))
    .some(aug => aug !== A.neuroFlux && !owned.has(aug));
}

/**
 * Does `factionName` still have an augmentation whose reputation requirement we
 * haven't reached - i.e. is working for its rep still useful? This is THE
 * predicate behind every "should the work slot go to this faction?" decision
 * (primary rep-banking, secondary faction work, idle rep work), which used to be
 * written out separately at each site with slightly different rules. The
 * options are those rules, made explicit:
 *
 * @param {NS} ns
 * @param {string} factionName
 * @param {Set<string>} owned   owned + queued augs (getOwnedAugmentations(true))
 * @param {object} [opts]
 * @param {string|null} [opts.excludeAug]  ignore this aug (the one we're already
 *        saving for - its rep is met; we're asking about OTHER augs)
 * @param {boolean} [opts.includeNFG]      count NeuroFlux Governor, whose rep
 *        requirement climbs with each level bought (idle rep work wants this;
 *        the targeted flows don't - NFG is the pre-install money dump)
 * @param {boolean} [opts.requirePrereqs]  only count augs whose prerequisites we
 *        own (secondary work: rep for an aug we couldn't buy is premature)
 */
export function factionRepStillUseful(ns, factionName, owned, opts = {}) {
  const { excludeAug = null, includeNFG = false, requirePrereqs = true } = opts;
  const s = ns.singularity;
  const faction = /** @type {any} */ (factionName);
  const rep = s.getFactionRep(faction);

  return s.getAugmentationsFromFaction(faction).some(aug => {
    if (aug === excludeAug) return false;
    if (aug === A.neuroFlux) {
      if (!includeNFG) return false;
    } else {
      if (owned.has(aug)) return false;
      if (requirePrereqs && !s.getAugmentationPrereq(aug).every(a => owned.has(a))) return false;
    }
    return s.getAugmentationRepReq(aug) > rep;
  });
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

  // Don't burn the bridge to an enemy that sells an install-priority aug this
  // faction doesn't, while that enemy is still joinable this run. The case this
  // exists for: parked in Chongqing for Tian Di Hui when cash crosses $20M, the
  // Chongqing invite arrives first, and accepting it bans Sector-12 - and with
  // it CashRoot Starter Kit - until the next install.
  // The same edge decides the head-to-head between two pending invites, ahead of
  // the aug count. (Both ways at once = no edge, so two enemies can't deadlock.)
  const s = ns.singularity;
  const joined = ns.getPlayer().factions ?? [];
  const augsOf = f => s.getAugmentationsFromFaction(/** @type {any} */ (f));
  const sellsPriorityOver = (a, b) => {
    const theirs = new Set(augsOf(b));
    return augsOf(a).some(aug => A.installPriority.includes(aug) && !owned.has(aug) && !theirs.has(aug));
  };
  const edge = (a, b) => sellsPriorityOver(a, b) && !sellsPriorityOver(b, a);
  const stillJoinable = e => !joined.includes(e) && !(F.cityEnemies[e] ?? []).some(x => joined.includes(x));
  if (enemies.some(e => stillJoinable(e) && edge(e, factionName))) return false;

  return !pendingInvites.some(other =>
    other !== factionName &&
    enemies.includes(other) &&
    !edge(factionName, other) &&
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
    backdoor: (server) => backdoorDone(ns, server),
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
 * The non-location join gates for a faction, evaluated against the player:
 * per-stat combat gaps (and whether all are met / "close"), the join-money
 * shortfall, the karma/kills/hacking gates, and the human-readable reasons
 * for whatever is still blocking. Shared by the city-gated and the
 * combat-gated branches of getUnjoinedFactionOpportunities, which used to
 * compute all of this separately.
 * @param {NS} ns @param {string} factionName @param {any} player
 * @param {Record<string, number> | null} combatReqs
 */
function joinGates(ns, factionName, player, combatReqs) {
  const skills = player.skills ?? {};
  const statGaps = {};
  let maxGap = 0;
  for (const [stat, needed] of Object.entries(combatReqs ?? {})) {
    const have = skills[stat] ?? 0;
    const gap  = Math.max(0, needed - have);
    statGaps[stat] = { have, needed, gap };
    if (gap > maxGap) maxGap = gap;
  }
  const statsMet = maxGap === 0;
  // "Close" means within closeStatGap levels on every stat.
  const isClose  = !statsMet && Object.values(statGaps).every(g => g.gap <= CONFIG.player.closeStatGap);

  const joinMoneyReq = F.joinMoney[factionName] ?? 0;
  const joinMoneyMissing = Math.max(0, joinMoneyReq - player.money);
  const extraGaps = getExtraRequirementGaps(ns, factionName, player);

  const reasonParts = [];
  if (!statsMet) reasonParts.push(`Combat stats needed (max gap: ${maxGap})`);
  if (joinMoneyMissing > 0) reasonParts.push(`Need $${(joinMoneyReq / 1e6).toFixed(1)}M`);
  reasonParts.push(...extraGaps.reasons);

  return { statGaps, maxGap, statsMet, isClose, joinMoneyReq, joinMoneyMissing, extraGaps, reasonParts };
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
 * Megacorp (company-rep) factions are not handled here: a node that opts in
 * passes lib/company-work.js's `opportunities` as `extra`, and its entries are
 * appended. Keeping those Singularity calls out of this file is what stops every
 * daemon paying 7GB for a branch only BN10 takes.
 *
 * @param {NS} ns
 * @param {((ns: NS, c: {player: any, joined: Set<string>, invited: Set<string>}) => any[]) | null} [extra]
 */
export function getUnjoinedFactionOpportunities(ns, extra = null) {
  const s = ns.singularity;
  const player = ns.getPlayer();
  const joined  = /** @type {Set<string>} */ (new Set(player.factions ?? []));
  const invited = /** @type {Set<string>} */ (new Set(s.checkFactionInvitations()));

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
      const done          = backdoorDone(ns, bdServer);
      const hackOk        = serverExists && ns.getHackingLevel() >= ns.getServerRequiredHackingLevel(bdServer);

      if (!done) {
        results.push({
          faction: factionName,
          reason:  hasRoot && hackOk ? "Ready to backdoor" : `Need backdoor on ${bdServer}`,
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
      const g = joinGates(ns, factionName, player, combatReqs);
      // canTravel = meets the join money req AFTER paying for the trip (when one
      // is needed), any karma/kill/hacking gates, AND combat stats (if any). The
      // fare has to come out first: with $1.1M we'd fly to Chongqing for Tian Di
      // Hui ($1M), land on $900k with no invite, and fly home again next tick -
      // $400k a round trip, for as long as income stayed under the fare.
      const fare = cityOptions.includes(currentCity) ? 0 : CONFIG.player.travelCost;
      const canTravel = player.money - fare >= g.joinMoneyReq && g.extraGaps.met && g.statsMet;
      const reason = g.reasonParts.length > 0
        ? `${g.reasonParts.join(", ")} to join ${factionName}`
        : `Travel to ${city}`;

      // Non-combat city factions (e.g. Tian Di Hui) stay "low" priority while
      // blocked rather than dropping to "future" - only demote to "future"
      // when there's an actual stat gap that isn't close yet.
      const urgency = canTravel ? "medium" : (combatReqs && !g.isClose) ? "future" : "low";

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
        joinMoneyMissing: g.joinMoneyMissing,
        extraGaps: g.extraGaps.reasons,
        needsBackdoor: false,
        backdoorServer: null,
        combatReqs: combatReqs ?? null,
        statGaps: g.statGaps,
        allStatsMet: g.statsMet,
        isClose: g.isClose,
        hackingFocus,
      });
      continue;
    }

    // Combat-stat-gated factions (Slum Snakes, Tetrads, etc.)
    if (combatReqs) {
      const g = joinGates(ns, factionName, player, combatReqs);
      const allMet = g.statsMet && g.joinMoneyMissing <= 0 && g.extraGaps.met;
      const reason = g.reasonParts.length > 0 ? g.reasonParts.join(" | ") : "Stats met - check invite";

      results.push({
        faction: factionName,
        reason,
        urgency: allMet ? "medium" : (g.statsMet || g.isClose) ? "low" : "future",
        invited: false,
        needsCity: false,
        city: null,
        needsBackdoor: false,
        backdoorServer: null,
        combatReqs,
        statGaps: g.statGaps,
        joinMoneyMissing: g.joinMoneyMissing,
        extraGaps: g.extraGaps.reasons,
        allStatsMet: g.statsMet,
        allRequirementsMet: allMet,
        isClose: g.isClose,
        hackingFocus,
      });
      continue;
    }

  }

  // Company-reputation-gated factions (megacorps), from the opted-in node's
  // lib/company-work.js - see the doc comment.
  if (extra) results.push(...extra(ns, { player, joined, invited }));

  return results;
}