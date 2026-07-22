// lib/config.js
//
// Every tunable value in the codebase, in one place. Nothing here is derived
// from game state - it's pure data plus two pure helpers - so this file has
// ZERO Netscript calls and therefore ZERO RAM cost. That's deliberate: Bitburner
// sums a script's RAM over its whole import closure, so a config module that
// touched `ns` would tax every importer, including the deliberately-lean
// early/driver.js. Keep it that way: no `ns.` anywhere in this file.
//
// ── Layout ───────────────────────────────────────────────────────────────────
//   CONFIG   - the shared defaults. BitNode-agnostic; import this directly from
//              any library that behaves the same everywhere.
//   BITNODE  - per-BitNode override struct, keyed by node number. Only holds the
//              keys that genuinely differ (e.g. the gang karma gate is -9 in BN2
//              but -54,000 everywhere else).
//   forNode(n) - CONFIG deep-merged with BITNODE[n]. Each bnX/daemon.js knows its
//              own node number literally, so it just calls forNode(2) / (3) / (4).
//
// ── Adding a BitNode override ────────────────────────────────────────────────
// Put the key in BITNODE[n] and read it through forNode(n). If the key is read by
// a SHARED library (lib/gang.js, lib/econ.js, ...) rather than a daemon, that
// library must switch from `CONFIG.x` to `forNode(ns.getResetInfo().currentNode).x`
// - getResetInfo() is free (0GB), so that costs nothing but must be done in the
// library's own file, never here.
//
// ── What is NOT here ─────────────────────────────────────────────────────────
//   - lib/gang.js's gain-formula replicas (the 11x, 0.2/0.8 softcap, 8e-5, ...).
//     Those transcribe the game's own src/Gang/formulas/formulas.ts; they're not
//     knobs, and splitting them from the formulas makes both unreadable.
//   - Dashboard CSS (pixel sizes, margins). Only the palette lives here.
//   - hacking/{hack,grow,weaken}.js have no constants at all.

// ── Shared defaults ──────────────────────────────────────────────────────────

export const CONFIG = {
  // Human-readable BitNode name. Only meaningful once resolved through
  // forNode() - BITNODE sets it per node.
  name: /** @type {string | null} */ (null),

  // Script + file paths. Referenced by name everywhere so a move is a one-line
  // change here.
  paths: {
    // This node's own daemon. Declared here (rather than only in BITNODE) so
    // `forNode(n).paths.daemon` type-checks for every n; BITNODE fills it in
    // for the nodes we actually have a daemon for.
    daemon: /** @type {string | null} */ (null),
    home: "home",
    hack: "/hacking/hack.js",
    grow: "/hacking/grow.js",
    weaken: "/hacking/weaken.js",
    share: "/hacking/share.js",
    manager: "/hacking/manager.js",
    worker: "/early/worker.js",
    driver: "/early/driver.js",
    gangBoot: "/early/gang-boot.js",
    dashboard: "/ui/dashboard.js",
    stocks: "/lib/stocks.js",
    gang: "/lib/gang.js",
    econ: "/lib/econ.js",
    backdoor: "/lib/backdoor.js",
    corpSteady: "/lib/corp-steady.js",
    corpBuild: "/lib/corp-build.js",
    corpCreate: "/bn3/corp-create.js",
    resetFile: "/data/last-reset.txt",
    // Killed by the cold-start driver if a previous run left it behind.
    legacyStartup: "/startup.js",
  },

  // The 5 port-opener programs. ORDER MATTERS: lib/net.js pairs this list
  // positionally with ns.brutessh/ftpcrack/relaysmtp/httpworm/sqlinject, and
  // lib/daemon-lib.js buys them in this order.
  programs: {
    portOpeners: [
      "BruteSSH.exe",
      "FTPCrack.exe",
      "relaySMTP.exe",
      "HTTPWorm.exe",
      "SQLInject.exe",
    ],
    torCost: 200_000,
    // Darkweb price of BruteSSH.exe, used to size the early-game money goal.
    bruteSshCost: 500_000,
    // Hacking level required to createProgram() each one manually, in priority
    // order. More programs = more rootable servers = more worker RAM.
    createHackReq: {
      "BruteSSH.exe": 50,
    },
  },

  // hacking/manager.js - the HGW batching botnet.
  hacking: {
    // Game constants: security added per thread, security removed per weaken.
    securityPerHack: 0.002,
    securityPerGrow: 0.004,
    weakenAmount: 0.05,
    // Landing gap between the H/W/G/W legs of a batch.
    batchSpacingMs: 200,
    // Kept free on home so the daemon and its children always have room.
    reserveHomeRam: 8,
    // Used before the real getScriptRam() readings land in main().
    fallbackRam: { hack: 1.7, grow: 1.7, weaken: 1.75 },
    // Fraction of a target's money to steal per batch, tried largest-first
    // until one fits in available RAM.
    moneyFractions: [0.10, 0.05, 0.025, 0.01, 0.005, 0.0025, 0.001],
    // A target counts as "prepped" within this much of min security and this
    // fraction of max money.
    prepSecurityTolerance: 5,
    prepMoneyThreshold: 0.95,
    prepSleepPadMs: 1_000,
    waitForRamMs: 2_000,
    // Always rootable and hackable at hacking level 1.
    defaultTarget: "n00dles",
    // Hacknet servers show up as rooted RAM but are terrible hack targets.
    excludeTargetPrefix: "hacknet-server",
  },

  // hacking/manager.js - faction-rep sharing (ns.share), a side mode of the
  // botnet. While the daemon is farming faction rep, dedicate a small, capped
  // slice of the botnet to ns.share(), which multiplies faction-WORK rep gain by
  //   1 + ln(effectiveShareThreads) / 25
  // (Bitburner's formula; effectiveThreads ≈ threads on 1-core servers). That
  // curve is steeply diminishing - each DOUBLING of share threads adds only
  // ln(2)/25 ≈ +2.8 percentage points - so a couple of servers captures most of
  // the benefit while the rest of the botnet keeps earning. The manager owns
  // this so share + hacking draw from one RAM plan (no reservation handshake).
  //
  // How the count is derived (see hacking/manager.js manageShare):
  //   1. budget = fraction × (eligible network RAM), i.e. "use a slice, not all"
  //   2. capped by targetBonus: past a target multiplier the curve is too flat
  //      to justify the money-RAM. threads_for(B) = e^(25·(B−1)); RAM = that ×
  //      per-thread (4.0GB). budget = min(fraction·total, threads_for·4.0, maxRam)
  //   3. place that budget on the fewest servers (largest-first), hard-capped at
  //      maxServers → the "a couple of servers" answer.
  share: {
    // Master on/off switch. Set false to instantly disable sharing (the botnet
    // reclaims all RAM next tick) without touching any other logic.
    enabled: true,
    // Enable only while the daemon's published action is faction WORK - share
    // boosts *worked* rep, not passive gang-faction rep. Matched by prefix
    // against globalThis.gordState.action; keep in sync with the daemon's action
    // strings ("Faction Rep", "Faction Work (...)", "Faction Rep (idle)").
    repActionPrefixes: ["Faction "],
    // Share budget as a fraction of eligible (rooted, non-home, non-reserved)
    // network RAM. This is the "don't use all the servers" knob.
    fraction: 0.20,
    // Never spread share across more than this many servers (largest-first), so
    // it stays "a couple". With large cloud servers, 2-3 is plenty of threads.
    maxServers: 3,
    // Upper bound on the rep multiplier we'll chase. Past this the log curve is
    // too flat to be worth the money-RAM. 1.25 ⇒ ~518 threads ⇒ ~2.1TB, which
    // only binds once the network is very large (else `fraction` binds first).
    targetBonus: 1.25,
    // Don't share below this budget (GB): early game every GB should hack, and a
    // tiny share barely moves the bonus anyway.
    minRam: 64,
    // Hard ceiling on share RAM (GB), regardless of fraction/target.
    maxRam: Infinity,
  },

  // early/worker.js - the dumb single-target fallback money engine.
  worker: {
    defaultTarget: "n00dles",
    securityTolerance: 5,
    moneyThreshold: 0.75,
  },

  // early/driver.js - cold-start bootstrap.
  driver: {
    // Free RAM the daemon needs on home on top of its own script size.
    workerHeadroom: 8,
    tickMs: 15_000,
    // Used when getScriptRam() fails (e.g. file not synced yet).
    fallbackWorkerRam: 2.5,
    // Node with no bnX/daemon.js of its own falls back to this.
    fallbackDaemon: "/bn4/daemon.js",
  },

  // lib/daemon-lib.js ensureHelper().
  helpers: {
    // Left free when a helper has to fall back to running on home.
    homeHeadroom: 8,
  },

  // lib/pserv.js - general purchased-server fleet management.
  pserv: {
    reserveMoney: 5e6,
    spendFraction: 0.25,
    hardSpendCap: Infinity,
    // Smallest purchasable tier; early game buys cheap rather than waiting.
    minRam: 2,
    namePrefix: "cloud-",
  },

  // Dedicated single-purpose cloud hosts (cloud-gang, cloud-corp).
  cloudHost: {
    // Never spend more than this fraction of cash provisioning one.
    spendFraction: 0.5,
    minRam: 2,
  },

  // lib/econ.js - hacknet + home-RAM spending, run off-home.
  econ: {
    tickMs: 15_000,
    // Hacknet stops being worth it past this hacking level.
    hacknetMaxHackingLevel: 200,
    hacknetBudgetFraction: 0.20,
    hacknetMinSpend: 1_000,
    hacknetMaxNodes: 8,
    // Only buy home RAM when the upgrade costs at most this share of cash.
    homeRamMaxCostFraction: 0.4,
    // Money kept untouched before spending on home RAM. Only a fallback: the
    // launching daemon passes this as exec arg [0], and BN2 passes its
    // gang.joinMoney there so a home-RAM buy can never starve the gang
    // bootstrap.
    homeRamReserve: 0,
  },

  // lib/backdoor.js - backdoors + finishing the BitNode, run off-home.
  backdoor: {
    tickMs: 10_000,
    // Order matters: faction-gating servers first, world daemon last.
    priority: [
      "CSEC",
      "avmnite-02h",
      "I.I.I.I",
      "run4theh111z",
      "The-Cave",
      "w0r1d_d43m0n",
    ],
    finalHost: "w0r1d_d43m0n",
    // BitNode to enter after destroying w0r1d_d43m0n, when none is passed in.
    defaultNextBN: 1,
  },

  // lib/gang.js (steady-state management) + early/gang-boot.js (BN2 bootstrap).
  gang: {
    maxMembers: 12,
    memberPrefix: "gord",
    tickMs: 2_000,
    // Ascend when the average ascension-multiplier gain reaches this.
    ascendGain: 1.5,
    // ...but not while still recruiting, if it would forfeit this much of the
    // respect pool the next recruit needs.
    ascendRespectFraction: 0.4,
    // Train fresh/just-ascended members to this average stat before earning.
    trainMinStat: 60,
    // Max fraction of player money per equipment item. Augs persist through
    // ascension, so they're worth paying more for.
    equipFraction: 0.01,
    augFraction: 0.05,
    // Territory warfare hysteresis on minimum clash win chance.
    warfareEngage: 0.60,
    warfareDisengage: 0.50,
    // Members below these contribute negligible power / die in live clashes.
    warfareMinStat: 200,
    warfareMinDef: 200,
    territoryDone: 0.999,
    // Push half the roster onto warfare until we out-power rivals by this much,
    // then drop to a token crew.
    rivalPowerMult: 1.5,
    tokenWarfareCount: 2,
    // Wanted-level feedback loop: below wantedLevelFloor we ignore it entirely.
    wantedLevelFloor: 10,
    wantedPenaltyBad: 0.90,
    wantedPenaltyMild: 0.99,

    // Placement. cloud-gang is reserved from the botnet when used.
    host: "cloud-gang",
    // Home must have (gang script RAM + this) before we host the gang there.
    homeHeadroom: 80,
    // Extra RAM reserved alongside the gang script when it runs on home.
    homeReserveSlack: 8,

    // Founding a gang. Default is the universal -54,000 karma gate; BN2
    // overrides this (see BITNODE) because it can found one at -9.
    karma: -54_000,
    // When true, the daemon treats reaching the karma gate above as a top
    // priority and ACTIVELY commits crime toward it (crime also builds the
    // combat stats that unlock criminal factions + their augs, and earns
    // money). When false (the default), we never grind toward it - we just snap
    // up a gang if ordinary crime-for-money happens to cross the gate. Turned on
    // for BN5, where hacking is heavily nerfed but gang income is un-softcapped,
    // so getting a gang online fast is the best early play. See [[startup-workflow]].
    activeKarmaGrind: false,
    // Bootstrap faction. Non-null ONLY on nodes with an early-gang shortcut -
    // early/driver.js uses this as the "can we boot a gang early?" test.
    faction: /** @type {string | null} */ (null),
    joinMoney: 0,
    // Criminal factions that can found a gang; whichever we're in gets used.
    criminalFactions: [
      "Slum Snakes",
      "Tetrads",
      "The Syndicate",
      "The Dark Army",
      "Speakers for the Dead",
    ],

    // early/gang-boot.js one-shot.
    bootCrime: "Mug",       // reliable at low stats; builds combat stats + karma
    bootTask: "Mug People", // positive money+respect, low wanted for a combat gang
    bootTickMs: 15_000,
  },

  // lib/stocks.js - the standalone trader.
  stocks: {
    commission: 100_000,
    // Tier 2 (4S forecast) thresholds.
    buyThreshold: 0.55,
    sellThreshold: 0.50,
    shortThreshold: 0.45,
    coverThreshold: 0.50,
    // Tier 1 (momentum, no 4S) thresholds.
    momentumBuyRatio: 1.005,
    momentumSellRatio: 0.999,
    momentumFast: 5,
    momentumSlow: 20,
    // Portfolio limits.
    reserveRatio: 0.10,
    maxPositionRatio: 0.30,
    // Minimum purchase for commission to be worth paying, as a multiple of it.
    minBuyCommissionMult: 20,
    // Required expected profit before entering, as a multiple of commission.
    minProfitCommissionMult: 2,
    // Share of cash we'll spend on each access upgrade.
    wseBudgetRatio: 0.10,
    tixBudgetRatio: 0.20,
    fourSBudgetRatio: 0.30,
    // Poll interval while we still have no TIX API.
    noTixSleepMs: 30_000,
    // Liquidate everything once this many augs are queued (install imminent).
    liquidateAugQueue: 4,
    // Rolling trade log length kept on globalThis for the dashboard.
    logLength: 20,
  },

  // lib/player-actions.js - everything that spends the player's own time.
  player: {
    // Powerhouse Gym only exists in Sector-12, which is also where home is.
    gym: "Powerhouse Gym",
    gymCity: "Sector-12",
    combatStats: ["str", "def", "dex", "agi"],
    studyLocation: "Rothman University",
    studyClass: "Algorithms",
    // Bootstrap: study to this hacking level, then mug once mug chance is good.
    earlyHackTarget: 50,
    earlyMugChance: 0.75,
    // If buying TOR + BruteSSH would take longer than this, create programs
    // manually instead of saving for them.
    slowIncomeThresholdMs: 10 * 60 * 1_000,
    // Flat $200k in Bitburner, for any city.
    travelCost: 200_000,
    // Minimum success chance before committing each crime.
    homicideMinChance: 0.8,
    mugMinChance: 0.5,
    // Rolling rate snapshots: minimum age before a snapshot yields a rate.
    incomeSnapshotMs: 5_000,
    repSnapshotMs: 5_000,
    // EMA weight on the newest income sample (older rate keeps 1 - this).
    incomeEmaAlpha: 0.2,
    // A combat-gated faction is "close" when every stat is within this.
    closeStatGap: 50,
    // Owning this aug removes the need to focus, freeing the player for
    // background work.
    noFocusAug: "Neuroreceptor Management Implant",
    // workForFaction job types, tried in this order.
    factionWorkTypes: ["hacking", "field", "security"],
  },

  // Augmentation purchase + install policy. Shared by all three daemons.
  augs: {
    neuroFlux: "NeuroFlux Governor",
    redPill: "The Red Pill",
    // Cheap early augs worth resetting for; also the gate for aggressive mode.
    installPriority: [
      "BitWire",
      "Neuralstimulator",
      "Neural-Retention Enhancement",
      "CashRoot Starter Kit",
      "Hacknet Node CPU Architecture Neural-Upload",
    ],
    install: {
      // Any one of these triggers an install (plus The Red Pill, always).
      queuedThreshold: 5,
      priorityQueuedThreshold: 2,
      // Floor for the two "one aug is enough" paths: the aggressive mode (every
      // priority aug already installed, so the price-multiplier reset wins) and
      // the time trigger below.
      minQueued: 1,
      // Reduced from 16h -> 8h: late-game aug prices compound fast.
      timeTriggerMs: 8 * 60 * 60 * 1_000,
    },
    // How many candidates the dashboard pipeline shows.
    pipelineSize: 10,
    // Two candidates within this relative ETA difference are treated as equal,
    // so we don't thrash between near-identical options.
    estimateTieTolerance: 0.10,
    // Sort rank for factions absent from factions.priority.
    unknownPriorityIndex: 99,
  },

  // Purchased-server budgets, keyed by what the daemon is currently saving for.
  infra: {
    // No aug target at all - spend freely.
    noTarget: { reserveMoney: 10e6, spendFraction: 0.25 },
    // Blocked on rep, so money is piling up anyway - spend the surplus.
    repPending: { reserveMoney: 50e6, spendFraction: 0.10, fallbackCapFraction: 0.05 },
    // Blocked on money - only nibble at the shortfall.
    savingSpendFraction: 0.05,
    savingBudgetFraction: 0.05,
    // Below this the nibble isn't worth a purchase; just report we're saving.
    minBudget: 1e6,
  },

  // The bnX/daemon.js main loop.
  daemon: {
    tickMs: 15_000,
  },

  // ── Faction + aug reference data (was lib/aug-targets.js) ──────────────────
  factions: {
    // Endgame-aug ordering, best first. Used as a sort tiebreaker when ETA
    // estimates are unavailable.
    priority: [
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
    ],

    // Combat/gang factions with join requirements we can work toward, but which
    // aren't part of `priority`'s endgame ordering. Scanned separately in
    // getUnjoinedFactionOpportunities so they aren't silently skipped.
    otherTracked: [
      "Slum Snakes",
      "Tetrads",
      "Speakers for the Dead",
      "The Dark Army",
      "The Syndicate",
    ],

    // Factions reachable via hacking level/backdoors rather than combat
    // grinding. Preferred whenever several opportunities are viable at once.
    hackingFocused: [
      "CyberSec",
      "NiteSec",
      "The Black Hand",
      "BitRunners",
      "Tian Di Hui",
      "Netburners",
    ],

    // Combat-stat gates. Keys match ns.getPlayer().skills.
    requirements: {
      "Slum Snakes": { strength: 30, defense: 30, dexterity: 30, agility: 30 },
      "Tetrads": { strength: 75, defense: 75, dexterity: 75, agility: 75 },
      "Speakers for the Dead": { strength: 300, defense: 300, dexterity: 300, agility: 300 },
      "The Dark Army": { strength: 300, defense: 300, dexterity: 300, agility: 300 },
      "The Syndicate": { strength: 200, defense: 200, dexterity: 200, agility: 200 },
    },

    // Money required to *join* (on top of other requirements). Only factions
    // where this is a meaningful gate. Verified against Bitburner's
    // FactionInfo.tsx inviteReqs - Speakers for the Dead, The Dark Army and
    // Tetrads have NO money requirement; Slum Snakes does ($1M).
    joinMoney: {
      "Tian Di Hui": 1_000_000,
      "The Syndicate": 10_000_000,
      "Slum Snakes": 1_000_000,
      "Sector-12": 15_000_000,
      "Aevum": 40_000_000,
      "Chongqing": 20_000_000,
      "New Tokyo": 20_000_000,
      "Ishima": 30_000_000,
      "Volhaven": 50_000_000,
    },

    // Factions requiring a visit to one of a set of cities (any one qualifies).
    // Verified against FactionInfo.tsx. Speakers for the Dead has NO city
    // requirement (it was previously mis-mapped to Volhaven).
    city: {
      "Tian Di Hui": ["Chongqing", "New Tokyo", "Ishima"],
      "The Syndicate": ["Aevum", "Sector-12"],
      "The Dark Army": ["Chongqing"],
      "Tetrads": ["Chongqing", "New Tokyo", "Ishima"],
      "Netburners": null, // no city req, but hacknet-based
    },

    // Non-combat, non-money gates, verified against FactionInfo.tsx inviteReqs.
    // karma is a CEILING (player.karma must be <= it, since more negative is
    // eviler); hacking/kills are floors. Not tracked: "not employed by CIA/NSA"
    // - the bot never takes those jobs.
    extraRequirements: {
      "Slum Snakes": { karma: -9 },
      "Tetrads": { karma: -18 },
      "The Syndicate": { hacking: 200, karma: -90 },
      "Speakers for the Dead": { hacking: 100, karma: -45, kills: 30 },
      "The Dark Army": { hacking: 300, karma: -45, kills: 5 },
    },

    // Factions that need a server backdoor before you can join.
    backdoor: {
      "CyberSec": "CSEC",
      "NiteSec": "avmnite-02h",
      "The Black Hand": "I.I.I.I",
      "BitRunners": "run4theh111z",
    },

    // Joining a city faction permanently bans its "enemies" for the rest of the
    // reset (FactionInfo.tsx `enemies`). Sector-12 and Aevum are NOT enemies of
    // each other; Volhaven is an enemy of every other city faction; Chongqing /
    // New Tokyo / Ishima are each enemies with Sector-12, Aevum and Volhaven but
    // not with each other.
    cityEnemies: {
      "Sector-12": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
      "Aevum": ["Chongqing", "New Tokyo", "Ishima", "Volhaven"],
      "Chongqing": ["Sector-12", "Aevum", "Volhaven"],
      "New Tokyo": ["Sector-12", "Aevum", "Volhaven"],
      "Ishima": ["Sector-12", "Aevum", "Volhaven"],
      "Volhaven": ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima"],
    },
  },

  // ── Corporation (BN3) ─────────────────────────────────────────────────────
  corp: {
    name: "GordCorp",
    host: "cloud-corp",
    // Fallback when seed funding is somehow unavailable. In BN3 the seed path
    // is free, so this effectively never fires.
    selfFundCost: 150e9,

    cities: ["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"],
    // Where products are designed; also produces + sells them.
    productCity: "Aevum",

    agriDivision: { name: "Agriculture", industry: "Agriculture" },
    tobaccoDivision: { name: "Tobacco", industry: "Tobacco" },

    unlocks: ["Warehouse API", "Office API", "Smart Supply"],

    // Dividend-tax ("tribute") reducers, bought once the corp is established
    // (past the farmed investment rounds) and can afford them without breaking
    // the operating reserve. Listed cheapest-first so Shady Accounting lands
    // before the much pricier Government Partnership. Buying Government
    // Partnership also grants the "Lobbying is great!" achievement
    // (CORPORATION_BRIBE = unlocks.has("Government Partnership")).
    taxUnlocks: ["Shady Accounting", "Government Partnership"],
    // The specific unlock that grants "Lobbying is great!" - surfaced so the
    // logger/dashboard can flag the achievement.
    lobbyingUnlock: "Government Partnership",

    // A throwaway Real Estate industry division, expanded (industry only - no
    // cities/warehouses/staff) purely for the "Own the land" achievement
    // (CORPORATION_REAL_ESTATE = any division whose industry is Real Estate).
    // Kept minimal so it never competes with Agriculture/Tobacco for funds.
    realEstate: { name: "RealEstate", industry: "Real Estate" },

    // Boost materials, and their per-unit warehouse footprint. Bought in this
    // order, split by the industry's own production factors.
    boostMaterials: ["Real Estate", "Hardware", "Robots", "AI Cores"],
    materialSize: { "Real Estate": 0.005, Hardware: 0.06, Robots: 0.5, "AI Cores": 0.1 },
    // Share of each warehouse reserved for boost materials.
    boostWarehouseFraction: 0.4,
    // Don't re-buy while stock is within this fraction of target.
    boostShortfallTolerance: 0.02,
    // Used when getIndustryData() is unavailable.
    defaultProducedMaterials: ["Plants", "Food"],

    // Employee role splits.
    jobsMaterial: {
      Operations: 0.32, Engineer: 0.26, Business: 0.20, Management: 0.16, "Research & Development": 0.06,
    },
    jobsProduct: {
      Operations: 0.24, Engineer: 0.28, Business: 0.16, Management: 0.12, "Research & Development": 0.20,
    },

    // Agriculture buildout targets per investment round; past round 2 we build
    // to agriTargetsMax.
    agriTargets: {
      1: { office: 4, warehouse: 4 },
      2: { office: 9, warehouse: 10 },
    },
    agriTargetsMax: { office: 14, warehouse: 18 },
    // Tobacco is the profit engine, so these are the main growth knobs. They're
    // only ceilings: every office/warehouse step is affordability-gated, so a
    // small corp grows slowly toward them and a rich one keeps scaling. Raised
    // from 30/9/12 - the old ceilings capped a mature corp well short of its
    // earning potential (the "corp isn't doing much" plateau).
    tobaccoTargets: { designOffice: 60, supportOffice: 20, warehouse: 16 },

    // Bought in strict order - never skip ahead to a cheaper later one. Market-
    // TA.II (auto-optimal product pricing) is the priority; AutoBrew and
    // AutoPartyManager come after it to auto-maintain employee energy/morale
    // (which otherwise decay and quietly throttle production).
    researchPriority: [
      "Hi-Tech R&D Laboratory",
      "Market-TA.I",
      "Market-TA.II",
      "AutoBrew",
      "AutoPartyManager",
    ],
    // Only buy research once we hold this multiple of its cost, so generation
    // keeps up.
    researchReserveMult: 2,

    // Corp-wide levelable upgrades, cheapest-affordable-first within budget.
    upgradePriority: [
      "Smart Storage",
      "Smart Factories",
      "FocusWires",
      "Neural Accelerators",
      "Speech Processor Implants",
      "Nuoptimal Nootropic Injector Implants",
      "ABC SalesBots",
      "Wilson Analytics",
      "Project Insight",
    ],

    // Never spend below this share of funds.
    fundsReserveFraction: 0.1,
    // Per-tick upgrade budget, as a share of the spendable remainder.
    upgradeBudgetFraction: 0.4,

    // AdVert is worth it while it costs at most this share of funds.
    adVertMaxFraction: 0.15,
    productAdVertMaxFraction: 0.25,

    // Product pipeline.
    productPrefix: "Tobacco-v",
    productInvestFraction: 0.02,
    productInvestCap: 1e12,
    // Below this a product isn't worth developing yet.
    productInvestMin: 1e9,
    // Only recycle a product slot if the new product would be this many times
    // better funded than the weakest existing one.
    productRecycleMult: 2,
    // Used when getDivision().maxProducts is unavailable.
    maxProductsFallback: 3,

    // Investment rounds we farm before switching to dividends.
    investmentRounds: 2,
    dividendRate: 0.1,
    dividendMinProfitPerSec: 1e9,

    // Loop guards on the incremental buy-one-step-at-a-time helpers.
    warehouseUpgradeSteps: 50,
    upgradeSteps: 200,
    // Office seats added per upgrade call.
    officeStep: 3,

    // Minimum gap between corp-steady status log lines (ns.print, 0 RAM). The
    // per-cycle tick fires several times a second, so we throttle the log.
    logEveryMs: 60_000,
  },

  // ── Dashboard ─────────────────────────────────────────────────────────────
  // Palette only. Layout CSS stays inline in ui/*.js - abstracting pixel values
  // buys nothing and makes the render code unreadable.
  ui: {
    colors: {
      green: "#4ade80",
      yellow: "#facc15",
      red: "#f87171",
      blue: "#60a5fa",
      purple: "#c084fc",
      dim: "rgba(255,255,255,0.45)",
      border: "rgba(255,255,255,0.10)",
      cardBg: "rgba(255,255,255,0.03)",
    },
    // DOM id on the dashboard root, used to measure height for tail sizing.
    rootId: "gordnet-dash",
    // Tail window geometry (the single GORDNET HUD). Height is measured from the
    // rendered content and clamped to [minHeight, maxHeight].
    tail: { x: 20, y: 0, width: 900, minHeight: 200, maxHeight: 2000 },
    // ui/dashboard.js HUD cadence. The loop polls every tickMs; it repaints on a
    // tab switch (so clicks feel snappy) or every uiRefreshMs otherwise (keeping
    // repaints rare enough that the JOURNAL tab's scroll survives between them).
    hud: {
      tickMs: 150,            // loop poll interval (tab-click responsiveness)
      uiRefreshMs: 1_000,     // repaint cadence when the tab hasn't changed
      statsRefreshMs: 5_000,  // how often to re-gather the heavier STATS-tab data
    },
    // ui/journal.js - the narrative "what am I doing and why" log, now a tab in
    // the HUD (not its own window).
    journal: {
      // Progress cadence for a long-running goal (karma / rep / savings). When a
      // goal reports a % complete, emit a progress line each time it crosses
      // another progressStepPct milestone (so ~one line per 5%). progressMs is
      // the fallback for goals with no clean %: at most one line per interval.
      progressStepPct: 5,
      progressMs: 90_000,
      // In-memory log ring buffer, how many lines the JOURNAL tab shows (newest
      // first), and the px height it scrolls inside (keeps the HUD bounded).
      bufferSize: 400,
      visibleLines: 100,
      panelHeight: 520,
    },
    // A combat stat counts as "close" to its gate within this many levels.
    closeStatGap: 50,
    // Combat stats shown on the player card, against the highest gate in
    // factions.requirements.
    combatStats: [
      { key: "strength", label: "STR" },
      { key: "defense", label: "DEF" },
      { key: "dexterity", label: "DEX" },
      { key: "agility", label: "AGI" },
    ],
    // Servers whose backdoor status is worth tracking.
    backdoorChecklist: [
      { server: "CSEC", label: "CyberSec" },
      { server: "avmnite-02h", label: "NiteSec" },
      { server: "I.I.I.I", label: "The Black Hand" },
      { server: "run4theh111z", label: "BitRunners" },
      { server: "The-Cave", label: "The Cave" },
      { server: "w0r1d_d43m0n", label: "World Daemon" },
    ],
    // Factions worth joining for aug access - shown as joined/pending.
    factionChecklist: [
      "CyberSec",
      "NiteSec",
      "The Black Hand",
      "BitRunners",
      "Daedalus",
      "Illuminati",
      "The Covenant",
    ],
  },
};

// ── Per-BitNode overrides ────────────────────────────────────────────────────
//
// Only the keys that genuinely differ from CONFIG. Deep-merged by forNode(),
// so a nested object here overlays CONFIG's object key-by-key rather than
// replacing it wholesale (arrays ARE replaced wholesale - see deepMerge).

export const BITNODE = {
  2: {
    name: "Rise of the Underworld",
    paths: { daemon: "/bn2/daemon.js" },
    gang: {
      // BN2's defining shortcut: a gang can be founded as soon as we can join a
      // criminal faction, with no -54,000 karma grind. Slum Snakes is the
      // cheapest way in (30 combat stats, -9 karma, $1M).
      faction: "Slum Snakes",
      karma: -9,
      joinMoney: 1_000_000,
    },
    // Note: the daemon forwards gang.joinMoney to lib/econ.js as its home-RAM
    // money reserve, so there's no separate econ override to keep in sync.
  },

  3: {
    name: "Corporatocracy",
    paths: { daemon: "/bn3/daemon.js" },
    // Gang keeps CONFIG's universal -54,000 karma gate: BN3 has no shortcut, so
    // we never grind toward it, we just snap one up when crime-for-money
    // eventually crosses the line.
  },

  4: {
    name: "The Singularity",
    paths: { daemon: "/bn4/daemon.js" },
  },

  5: {
    name: "Artificial Intelligence",
    paths: { daemon: "/bn5/daemon.js" },
    gang: {
      // BN5 nerfs hacking hard (ScriptHackMoney 0.15, ServerStartingSecurity 2,
      // ServerStartingMoney 0.5, HackExpGain 0.5) and reduces corporations
      // (CorporationValuation/Divisions 0.75), but leaves gang income
      // un-softcapped. So the strongest early engine is a GANG. There's no -9
      // shortcut here (that's BN2 only), so we keep CONFIG's universal -54,000
      // karma gate and ACTIVELY grind crime toward it - crime simultaneously
      // builds combat stats (unlocking criminal factions and their augs) and
      // earns money (CrimeMoney 0.5 still beats ScriptHackMoney 0.15). `faction`
      // stays null (inherited) so early/driver.js won't try the BN2 gang-boot
      // one-shot, which only works at the -9 shortcut.
      activeKarmaGrind: true,
    },
  },
};

// ── Resolution ───────────────────────────────────────────────────────────────

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Overlay `override` onto `base`, recursing into plain objects. Arrays and
 * primitives are replaced wholesale - an override that lists three factions
 * means exactly those three, not "the defaults plus three".
 */
function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return out;
}

/** @type {Map<number, typeof CONFIG>} */
const _resolved = new Map();

/**
 * The config for a given BitNode: CONFIG deep-merged with BITNODE[node].
 * Each bnX/daemon.js knows its own node number literally, so it calls
 * forNode(2) / forNode(3) / forNode(4) at module scope. Anything that must
 * resolve at runtime can pass ns.getResetInfo().currentNode (free, 0GB).
 * Unknown nodes get the plain defaults.
 * @param {number} node
 */
export function forNode(node) {
  let cfg = _resolved.get(node);
  if (!cfg) {
    cfg = deepMerge(CONFIG, BITNODE[node] ?? {});
    _resolved.set(node, cfg);
  }
  return cfg;
}
