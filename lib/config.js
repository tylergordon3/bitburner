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
    sleeves: "/lib/sleeves.js",
    grafting: "/lib/grafting.js",
    contracts: "/lib/contracts.js",
    econ: "/lib/econ.js",
    backdoor: "/lib/backdoor.js",
    // The 32GB destroyW0r1dD43m0n tail, split out of backdoor.js so the backdoor
    // loop itself stays small enough to actually get placed - see lib/finish-bn.js.
    finishBn: "/lib/finish-bn.js",
    // The corporation manager, split into one always-on pair plus four bounded
    // one-shot "build phases". The split is about RAM: every corporation getter
    // costs 10GB and every action 20GB, so a script's size is set by how many
    // DISTINCT corp calls it can reach. One monolithic builder reached ~30 of them
    // (~490GB) and could only be placed on a very large host; four focused phases
    // are ~120-200GB each and the daemon runs them in rotation, so peak footprint
    // is one phase. See lib/corp-daemon.js for the rotation.
    corpUpkeep: "/lib/corp-upkeep.js",   // tea + party, always on, deliberately tiny
    corpSteady: "/lib/corp-steady.js",   // products, Wilson/Advert, upgrades, dividends
    corpExpand: "/lib/corp-expand.js",   // unlocks, industries, cities, warehouses, exports
    corpOffice: "/lib/corp-office.js",   // office size, hiring, job assignment, Advert levels
    corpMarket: "/lib/corp-market.js",   // Smart Supply, inputs, boost materials, selling, research
    corpInvest: "/lib/corp-invest.js",   // investment rounds, dummy divisions, going public
    corpCreate: "/lib/corp-create.js",
    resetFile: "/data/last-reset.txt",
    // One-shot handoff from an aug install to the next boot's journal: what was
    // installed + how long the run lasted. Written just before installAugmentations,
    // consumed (and blanked) once on the following boot. Separate from resetFile so
    // resetFile stays a plain timestamp that readLastResetTime() can Number()-parse.
    resetSummaryFile: "/data/last-reset-summary.txt",
    // The two HUD-header toggles, persisted (see lib/toggles.js for why, and
    // ui/dashboard.js for the buttons). Each holds the literal string "on" or "off";
    // anything that isn't "off" reads as on, so a missing file is the old behaviour.
    //   focusFile      - AUTO-FOCUS. Off => work goes out unfocused so the game
    //                    stops pinning the UI to its work screen. Owned by
    //                    lib/player-actions.js (focusFlag).
    //   autoFinishFile - AUTO-FINISH. Off => the daemon runs exactly as normal and
    //                    still backdoors w0r1d_d43m0n, but never destroys it. Owned
    //                    by lib/daemon-lib.js (ensureBackdoorHelpers).
    focusFile: "/data/auto-focus.txt",
    autoFinishFile: "/data/auto-finish.txt",
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

  // hacking/manager.js - the HGW batching botnet. The sizing/scheduling math is
  // the pure lib/batch-logic.js; these are its knobs.
  hacking: {
    // Game constants: security added per thread, security removed per weaken.
    securityPerHack: 0.002,
    securityPerGrow: 0.004,
    weakenAmount: 0.05,
    // Landing gap between the H/W/G/W legs of a batch. Legs land at W-2s, W,
    // W+2s, W+3s (see legSchedule), so one batch's landings span 5 gaps.
    batchSpacingMs: 200,
    // Extra gap between one batch's last landing and the next batch's first.
    // Launch interval = span + this, which is what keeps batches from
    // interleaving as leg times shrink with hacking level / timers jitter.
    launchMarginMs: 200,
    // Ceiling on batches in flight per target (each is 4 processes). Past it the
    // launch interval stretches and batches get fatter instead of more numerous.
    maxDepth: 60,
    // Slack added after a batch's last planned landing before its RAM is
    // considered released (covers exec/timer jitter).
    landingPadMs: 500,
    // Kept free on home so the daemon and its children always have room.
    reserveHomeRam: 8,
    // Used before the real getScriptRam() readings land in main().
    fallbackRam: { hack: 1.7, grow: 1.7, weaken: 1.75 },
    // Fractions of a target's money a batch may steal. The scheduler fixes how
    // many batches are in flight from timing alone, then takes the LARGEST of
    // these whose batch fits (total botnet RAM / depth) - fatter bites cost more
    // grow per dollar, so RAM that would otherwise idle is the only reason to
    // take them.
    moneyFractions: [0.5, 0.25, 0.10, 0.05, 0.025, 0.01, 0.005, 0.0025, 0.001],
    // Never plan a hack that steals more than this (also the grow model's sanity cap).
    maxHackFraction: 0.9,
    // Fraction batches are costed at when RANKING targets ($ per GB-second).
    scoreFraction: 0.05,
    // A target counts as "prepped" within this much of min security and this
    // fraction of max money. Tight on purpose: leg durations scale with security,
    // and the batch ordering guarantee assumes the prepped timings.
    prepSecurityTolerance: 1,
    prepMoneyThreshold: 0.95,
    prepSleepPadMs: 1_000,
    waitForRamMs: 2_000,
    // Drift check while batches are in flight: the open batch explains a money
    // dip of its fraction and a security rise of its added security; anything
    // beyond that plus these tolerances means the ordering broke (or someone
    // else is hacking the target) - stop launching, let the window drain, re-prep.
    driftMoneyTolerance: 0.05,
    driftSecurityTolerance: 1,
    // Prep the runner-up target with RAM the primary's cycle doesn't need, so a
    // target switch starts batching immediately instead of with a full prep.
    prepRunnerUp: true,
    runnerUpMinRam: 64,
    // Cadences for the expensive scans; none of these change tick to tick.
    networkRescanMs: 5_000,   // ns.scan walk of the whole network
    rootRetryMs: 5_000,       // retry rooting unrooted servers
    targetRescoreMs: 10_000,  // re-rank hack targets
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
    // Throttle on the journal warning for a REQUIRED helper that can't be placed
    // (ensureHelper runs every tick, so without this it would spam).
    warnMs: 5 * 60 * 1_000,
  },

  // lib/pserv.js - general purchased-server fleet management.
  //
  // Deliberately conservative: server RAM only multiplies hacking income, while
  // cash buys augmentations, sleeves and grafts outright, so the fleet gets a
  // slice of income rather than the run of the treasury. Note managePurchasedServers
  // is called EVERY daemon tick and spends its whole budget each time, so a
  // fraction here is really "this share of net worth, every 15 seconds" - which is
  // why these were halved and given an absolute ceiling.
  pserv: {
    reserveMoney: 10e6,
    spendFraction: 0.10,
    // Absolute ceiling per call, whatever the fractions work out to. Without it,
    // late-game wealth turns a 10% slice into billions a tick spent on RAM the
    // botnet can't convert fast enough.
    hardSpendCap: 1e9,
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

  // lib/backdoor.js (backdoors) + lib/finish-bn.js (destroying w0r1d_d43m0n),
  // both run off-home. Split because the finisher's single 32GB call used to keep
  // the backdoor loop from ever being placed - see those files' headers.
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
    // When true the bot NEVER touches finalHost: lib/backdoor.js drops it from its
    // target list and lib/finish-bn.js refuses to run at all. Backdooring the world
    // daemon is not a harmless free step - it IS the finish (installBackdoor there
    // opens the BitVerse, exactly like the terminal command), so a node the player
    // means to end by hand sets this. Default off; BN10 turns it on.
    skipFinalHost: false,
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

  // lib/sleeves.js - the duplicate-sleeve manager. Like the gang manager it's
  // RAM-heavy (ns.sleeve.* is 4GB PER method, ~72GB total) so it runs OFF-home,
  // exec'd by EVERY daemon onto whatever host has room. It self-exits where the
  // sleeve API is unavailable (no SF10 and not BN10) or where we own no sleeves,
  // so launching it everywhere is inert on nodes that can't use it.
  //
  // ── What it does, in two modes ──────────────────────────────────────────────
  // Every sleeve first clears SHOCK (which also unlocks buying it augmentations -
  // the game refuses while shock > 0) and then SYNCHRONIZES, because both scale
  // everything that follows. What "productive" means afterwards depends on whether
  // we have a gang yet:
  //
  //   GANG BOOTSTRAP (gang API available, no gang yet) - the sleeve roster is the
  //     fastest karma engine we have, so crimes are ranked by KARMA per ms rather
  //     than money (homicide's 3.0 a hit against mug's 0.25). That's the "train up
  //     for mugging, mug until homicide" ladder: gym the weakest combat stat until
  //     the sleeve can land a mug at crimeMinChance, mug, then switch to homicide
  //     the moment homicide clears the same bar (where it's ~8x the karma rate).
  //
  //   MIRROR (we're in a gang, or gangs aren't available here) - each sleeve
  //     shadows the PLAYER's own work slot: same crime, same faction (preferring
  //     the same job type), same company, same gym stat or university course. When
  //     the sleeve can't do it (too weak for the crime, faction won't take it) it
  //     falls back to its own money-best crime, then the gym.
  //
  // ── BN10 additionally opens the SHOP ────────────────────────────────────────
  // BitNode 10 is the ONE place The Covenant sells extra sleeves (the last ~1e20)
  // and per-sleeve memory (1..100, which sets a sleeve's STARTING sync in every
  // future BitNode). purchaseSleeve/upgradeMemory only work there, so those two
  // steps are gated on shopBitNode; augmentations are bought everywhere.
  sleeves: {
    tickMs: 5_000,
    memoryMax: 100,

    // The BitNode whose Covenant sells sleeves + memory. Outside it the shop steps
    // are skipped entirely (the API calls would just fail), while shock/sync/augs/
    // assignment all run exactly the same.
    shopBitNode: 10,
    // Master switch for MIRROR mode. Off => a sleeve past the gang bootstrap runs
    // its own money-best crime ladder instead of shadowing the player.
    mirrorPlayer: true,
    // ...with one deliberate exception. Studying is the daemon's LAST-RESORT idle
    // action ("no faction work available"), and while it's the best thing left for
    // the player, it's the worst thing for a sleeve: tuition per sleeve, no income,
    // and its own crime ladder would both earn and sync combat exp back. So a
    // studying player isn't mirrored by default; a mirrored GYM workout still is,
    // since that's free and feeds the sleeve's own crime chance. Flip true if you'd
    // rather the roster copy the player literally.
    mirrorStudy: false,

    // A single sleeve purchase may cost at most this fraction of current cash, so
    // buying a sleeve always leaves an operating reserve for augs/servers. Because
    // getSleeveCost() climbs steeply, this naturally defers each buy until we're
    // rich enough that it's a small slice of net worth.
    buyMaxSpendFraction: 0.5,
    // Per-tick ceiling on total memory spending, as a fraction of cash. Memory is
    // a permanent, cross-BitNode investment, so we buy it steadily rather than
    // draining the treasury in one tick.
    memoryMaxSpendFraction: 0.5,
    // Memory yields to the next SLEEVE while that sleeve costs at most this multiple
    // of spendable cash - i.e. while it's close enough to be worth saving for. A
    // sleeve is worth more than memory twice over (an extra earner now, plus its own
    // 99 memory levels to buy later), but getSleeveCost climbs to ~1e20, so an
    // unreachable one must NOT block memory indefinitely: that's how a BN10 run ends
    // with no memory bought at all, having skipped the only upgrade that carries into
    // the next node. 4 => save while we're within a 4x income multiple of the next
    // sleeve; past that, spend on memory and re-evaluate as cash grows.
    memoryDeferSleeveReach: 4,
    // Per-tick ceiling on sleeve-AUGMENTATION spending, same basis. Augs are bought
    // cheapest-first across the whole roster and pay off immediately (they raise
    // that sleeve's multipliers for the rest of the node), so this is deliberately
    // less stingy than the server budgets - but still a slice, not the treasury.
    augMaxSpendFraction: 0.25,
    // ...but not before the player holds this much. On a node the manager now runs
    // in from the very start, a fraction of a tiny early treasury is still money we
    // need for TOR + the port openers, and a cheap sleeve aug is worth far less than
    // getting the botnet rooted. Above it, sleeve augs are among the best $/benefit
    // buys going.
    augMinMoney: 10e6,

    // Shock at or below this counts as "recovered" -> stop recovery, start sync.
    // ZERO on purpose: the game refuses to sell a sleeve an augmentation while its
    // shock is above 0, so stopping recovery at 1 (the old value) left every sleeve
    // permanently un-augmentable. Full recovery also removes the earnings penalty
    // outright, and the last point of shock takes very little time to shed.
    shockRecoveredBelow: 0,
    // Synchronize until sync reaches this, then switch to productive work. Sync
    // scales how much of a sleeve's exp/earnings flow back to the player, so it's
    // worth maxing before earning in earnest.
    syncTarget: 100,

    // ── Productive work once a sleeve is shock-clear and synced ──────────────
    // Crimes considered each tick; the best EXPECTED $/ms wins (lib/crime-logic.js
    // does the math off ns.formulas.work chances + gains). Order is only a
    // tiebreaker between equal rates.
    crimeCandidates: ["Homicide", "Mug"],
    // Per-attempt durations (ms). Game constants (Crimes.ts) - no multiplier
    // touches them - and there's no formulas call that returns them, so they're
    // listed here rather than paying for ns.singularity.getCrimeStats off-home.
    crimeTimeMs: { Homicide: 3_000, Mug: 4_000 },
    // Karma per SUCCESSFUL attempt, same source and same reason: ns.formulas.work
    // .crimeGains returns a WorkStats, which has no karma field. Used only by the
    // gang-bootstrap ranking (see the mode note above), where homicide's 12x
    // per-attempt edge is what pulls it ahead of mug.
    crimeKarma: { Homicide: 3, Mug: 0.25 },
    // Below this success chance on its best crime, a sleeve's time is better spent
    // getting stronger: faction field work for whatever faction the player is
    // grinding, else the gym. It's therefore also the GYM GRADUATION bar - a sleeve
    // trains until it can land a mug this reliably, then starts criming.
    crimeMinChance: 0.5,
    // Keep committing the crime we're already on unless the other beats it by this
    // margin - re-issuing a crime forfeits progress toward the current attempt.
    crimeStickyMargin: 0.95,
    // Powerhouse Gym is the best gym and only exists in Sector-12. A sleeve must be
    // in the gym's city to train there, so we travel it once (flat $200k, same as
    // the player's) and it stays.
    gym: "Powerhouse Gym",
    gymCity: "Sector-12",
    travelCost: 200_000,
    // Where a MIRRORing sleeve takes a university course when the player is
    // studying. We don't copy the player's own campus: Rothman is in Sector-12,
    // which is where the gym already puts every sleeve, so mirroring a class never
    // costs an extra trip. (Tuition still applies per sleeve - it's cheap by the
    // time a gang exists, which is the only time mirror mode runs.)
    studyLocation: "Rothman University",
    // The four GymType ids, used to tell a mirrored gym workout ("str") apart from
    // a mirrored university course ("Algorithms") - both arrive as a CLASS task.
    gymStats: ["str", "def", "dex", "agi"],
    // Faction work types tried, in order, for the faction the player is grinding
    // (globalThis.gordFactionWork). Field work first: it's the all-round combat-exp
    // option, so a sleeve too weak to crime still trains toward crime while it
    // banks rep. Factions that don't offer a type just fall through to the next.
    factionWorkTypes: ["field", "hacking", "security"],
    // globalThis.gordFactionWork is a heartbeat, not a latch: the daemon re-stamps
    // it every tick it keeps working a faction (see recordFactionWork in
    // lib/player-actions.js). A record older than this means the grind moved on -
    // or the daemon died - so sleeves fall back to gym/crime. 4 daemon ticks.
    factionWorkStaleMs: 60_000,
    // Fallbacks for when Formulas.exe is absent (no exact success chance available):
    // weakest-combat-stat proxies for the ~50% chance point of each crime, plus the
    // crimes' base payouts, which together keep the rate check ordering them right.
    fallbackMugCombat: 30,
    fallbackHomicideCombat: 100,
    crimeFallbackMoney: { Homicide: 45_000, Mug: 36_000 },

    // The faction that sells sleeves + memory. Purchases go through the sleeve API
    // (gated on BitNode 10, not on membership), but joining The Covenant is on the
    // normal aug path anyway, so the daemon keeps pursuing it.
    covenantFaction: "The Covenant",
  },

  // lib/grafting.js - the augmentation-grafting manager (VitaLife, New Tokyo).
  // Like the sleeve manager it's a RAM-heavy off-home helper (ns.grafting.* is
  // ~20GB across the 4 methods used) that the daemon exec's onto whatever host
  // has room; its only import is lib/config.js (0 RAM). It publishes
  // globalThis.gordGraftState each tick and reads two flags the daemon sets:
  // gordGraftAllow (===true only when the player's work slot is genuinely idle,
  // so a graft never cancels active progression) and gordMoneyFloor (so grafting
  // pauses during money-gated-invite hoards, exactly like the sleeve shop).
  //
  // Grafting installs an aug WITHOUT a reset - the whole point in BN10's long,
  // no-reset run - but each completed graft adds +1 Entropy, a PERMANENT -2% to
  // every multiplier. So the daemon doesn't graft on a fixed schedule: this helper
  // computes, each tick, whether grafting the best candidate beats what the player
  // would otherwise earn (idle crime), in money-per-player-time terms, and only
  // then reports it "worthwhile". See lib/grafting.js for the full model.
  grafting: {
    tickMs: 5_000,

    // Hard ceiling on accumulated Entropy (ns.getPlayer().entropy). Each graft is
    // +1. Past this we stop grafting - the -2%/level multiplier decay outweighs
    // another aug. 25 => multipliers at ~0.98^25 ≈ 0.60 of base, the agreed floor.
    entropyCap: 25,

    // A single graft may cost at most this fraction of SPENDABLE cash (cash above
    // gordMoneyFloor). Re-read after the floor so grafting never eats an invite
    // hoard, and keeps an operating reserve for augs/servers/sleeves.
    buyMaxSpendFraction: 0.25,

    // ── Cost/benefit model knobs (see lib/grafting.js) ───────────────────────
    // A graft is "worthwhile" when its value-rate (money-equivalent permanent
    // value per ms of player work) is at least this multiple of the player's idle
    // crime rate (the opportunity cost of the work slot). 1.0 = "graft whenever it
    // beats criming"; raise to demand grafting be strictly better before yielding
    // the player slot.
    worthwhileThreshold: 1.0,
    // Money-equivalent value of an aug ≈ its graft price × this. Graft price scales
    // with the aug's power, so it's the cheapest available power proxy; the weight
    // lets you treat a permanent aug as worth more (or less) than its sticker price
    // over the remaining run. Folds into worthwhileThreshold - only the product
    // matters - so leave one at 1.0 and tune the other.
    valueMult: 1.0,

    // The idle-crime opportunity cost is the rate of whichever crime the player
    // would actually be committing, decided by the same expected-$/ms check
    // player-actions uses (lib/crime-logic.js over CONFIG.player.crimeCandidates).
    // Only that $/ms rate is read here; the daemon still drives the real crime.

    // Grafting can only be STARTED in New Tokyo (VitaLife); the helper travels here
    // itself before grafting, and the daemon publishes this as its stay-city so the
    // auto-travel-home loop won't yank the player out mid-graft.
    city: "New Tokyo",
    travelCost: 200_000,

    // Pass focus=true to graftAugmentation unless this aug is installed (the
    // no-focus perk lets grafting run in the background without stealing the UI).
    noFocusAug: "Neuroreceptor Management Implant",

    // Master switch. Only bn10/daemon.js launches this helper, and it self-exits
    // where the grafting API is unavailable (no SF10), so this stays inert
    // elsewhere; flip false to disable grafting without touching the daemon.
    enabled: true,
  },

  // lib/contracts.js - the network-wide coding-contract solver, run off-home. A
  // universal, node-agnostic income/rep source the botnet ignores: contracts (.cct
  // files) spawn on random servers over time and pay money, faction/company rep,
  // or karma. The helper scans the whole network each tick, solves the types it
  // knows (lib/contract-solvers.js - all 30 v3 types), and SKIPS unknown/future
  // types without spending a limited attempt. Cheap and low-frequency; ~25GB of
  // ns.codingcontract.* keeps it off-home like the other helpers.
  contracts: {
    // Contracts are rare and non-urgent, so poll infrequently.
    tickMs: 60_000,
    // Master switch - flip false to stop solving (e.g. to grind a contract by hand).
    enabled: true,
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
    // Crimes the player's rate check considers: whichever has the best EXPECTED
    // yield per ms wins (lib/crime-logic.js), rather than waiting for homicide to
    // clear a fixed success chance. Order is only a tiebreaker between equal rates.
    crimeCandidates: ["Homicide", "Mug"],
    // A crime we'd fail more often than this isn't worth the player's time at all;
    // if no candidate clears it we do something else (train/study/faction work).
    crimeMinChance: 0.5,
    // Keep the crime we're already committing unless the other beats it by this
    // margin - commitCrime restarts the attempt, forfeiting its sunk progress.
    crimeStickyMargin: 0.95,
    // Minimum success chance for the standalone "homicide only if it's a safe bet"
    // helper (commitHomicideIfUseful) - the rate check above doesn't use it.
    homicideMinChance: 0.8,
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
  // All of these are per-tick shares of cash (see the pserv note above), so they're
  // set to keep the fleet growing steadily in the background while the bulk of
  // income stays banked for augs/sleeves/grafts.
  infra: {
    // No aug target at all - the freest case, but still a modest slice.
    noTarget: { reserveMoney: 25e6, spendFraction: 0.10 },
    // Blocked on rep, so money is piling up anyway - spend some of the surplus.
    repPending: { reserveMoney: 100e6, spendFraction: 0.05, fallbackCapFraction: 0.02 },
    // Blocked on money - only nibble at the shortfall.
    savingSpendFraction: 0.02,
    savingBudgetFraction: 0.02,
    // Below this the nibble isn't worth a purchase; just report we're saving.
    minBudget: 5e6,
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
    //
    // Sector-12 and Aevum are here for the same reason: they're plain city factions
    // (be in the city, hold the join money) whose augs we want, and until they were
    // tracked the bot only ever joined one by accident - it never travelled or saved
    // toward them. They're the one PAIR of city factions that aren't enemies of each
    // other (see cityEnemies), so joining both is free; picking either bans
    // Chongqing / New Tokyo / Ishima / Volhaven, which is the standard trade.
    otherTracked: [
      "Slum Snakes",
      "Tetrads",
      "Speakers for the Dead",
      "The Dark Army",
      "The Syndicate",
      "Sector-12",
      "Aevum",
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
      // The city factions themselves: live there, hold the join money (see
      // joinMoney), get invited. Only the non-mutually-hostile pair is listed -
      // see the note on otherTracked.
      "Sector-12": ["Sector-12"],
      "Aevum": ["Aevum"],
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

    // Megacorporation factions - unlocked by getting a job at the company and
    // grinding its reputation to the invite gate (~400k), NOT by city/backdoor/
    // combat. getUnjoinedFactionOpportunities only surfaces these when the current
    // node opts in via `pursueCompanyFactions` (default off, so bn2-5 are wholly
    // unaffected) AND the faction still has an unowned aug. The daemon then works
    // the company from anywhere (Singularity company work isn't city-locked), and
    // the game auto-invites at the gate. Fulcrum Secret Technologies is omitted on
    // purpose: it additionally needs a backdoor on `fulcrumassets`, which our
    // backdoor helper doesn't target, so we'd grind rep that never converts.
    pursueCompanyFactions: false,
    // Money-gated invites (Daedalus $100b, The Covenant $75b, Illuminati $150b,
    // etc.): the invite only fires while you HOLD the required cash, but the bot
    // otherwise spends money away (augs, NeuroFlux, servers, sleeves) before it
    // ever crosses the line. When every OTHER requirement for such a faction is
    // met, the daemon sets a money floor (globalThis.gordMoneyFloor) that all
    // spenders respect, and holds cash until the invite arrives, then resumes.
    // Actual thresholds are read live via ns.singularity.getFactionInviteRequirements
    // (so BitNode multipliers are honoured) - nothing here is hard-coded.
    hoardMoneyGatedInvites: true,
    // Only hoard for invites whose money gate is at least this large, so trivial
    // city-faction money reqs ($1M) are left to the normal travel/join flow.
    minHoardMoney: 1e9,
    // Whether Singularity company work needs us physically in the company's city.
    // When true, the auto-travel loop routes us to (and keeps us in) the company's
    // city while grinding its rep, yielding to combat-training trips home. When
    // false we grind from wherever we are (works if your build doesn't city-lock
    // Singularity company work). BN10 defaults this true for safety.
    companyWorkNeedsCity: false,
    companyRepReq: 400_000,
    // JobField (see ns.enums.JobField) tried in order when applying; first that
    // yields a position is taken, and the company auto-promotes us over time.
    // Software first (this is a hacking-heavy build, so Hacking stat is highest),
    // Business as the charisma fallback.
    companyFieldPriority: ["Software", "Business", "Security"],
    companyFactions: {
      "ECorp":                  { company: "ECorp",                  city: "Aevum" },
      "MegaCorp":               { company: "MegaCorp",               city: "Sector-12" },
      "Bachman & Associates":   { company: "Bachman & Associates",   city: "Aevum" },
      "Blade Industries":       { company: "Blade Industries",       city: "Sector-12" },
      "NWO":                    { company: "NWO",                    city: "Volhaven" },
      "Clarke Incorporated":    { company: "Clarke Incorporated",    city: "Aevum" },
      "OmniTek Incorporated":   { company: "OmniTek Incorporated",   city: "Volhaven" },
      "Four Sigma":             { company: "Four Sigma",             city: "Sector-12" },
      "KuaiGong International":  { company: "KuaiGong International",  city: "Chongqing" },
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

  // ── Corporation (all corp-viable BitNodes) ────────────────────────────────
  // Strategy follows the community "Corporation manual": an Agriculture +
  // Chemical + Tobacco supply chain with export loops, all four investment
  // rounds, mandatory per-cycle tea/party, Engineer-prioritised quality in the
  // product rounds, Wilson->Advert spend discipline, and go-public dividends.
  // The per-round office/warehouse/advert numbers are seeded from the guide but
  // used only as affordability-gated CEILINGS, so the same config works in
  // valuation-penalised nodes (it just grows toward them more slowly).
  corp: {
    name: "GordCorp",
    host: "cloud-corp",
    // Master switch, per node. Deep-merged by forNode(), so a BITNODE override
    // can flip it off for a node where a corp is a poor trade. Default on now
    // that we have corp API access everywhere.
    enabled: true,
    // Self-funded creation cost ($150b). In BN3 the seed path is free so this
    // never fires; elsewhere it's the only path, gated by selfFundBuffer so we
    // never drain the player to found a corp.
    selfFundCost: 150e9,
    // Only self-fund once the player holds this multiple of selfFundCost, so
    // founding a corp never stalls aug/program progression.
    selfFundBuffer: 3,

    cities: ["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"],
    // Where products are designed; also produces + sells them.
    productCity: "Aevum",

    agriDivision: { name: "Agriculture", industry: "Agriculture" },
    // Support division: turns Agriculture's Plants into high-quality Chemicals,
    // which are exported back to Agriculture to lift its output quality (the
    // quality loop). Kept deliberately small - it only has to feed the loop.
    chemicalDivision: { name: "Chemical", industry: "Chemical" },
    tobaccoDivision: { name: "Tobacco", industry: "Tobacco" },

    // Export routes set up once the divisions + "Export" unlock exist. FIFO:
    // Tobacco is listed before Chemical so the product division draws Plants
    // first (guide advice). The amount is the manual's optimal export string
    // (18.2): ship what the importer consumes per second (IPROD) plus a tenth of
    // its standing inventory, so an importer that has fallen behind gets topped
    // back up instead of coasting on exactly break-even flow.
    exports: [
      { from: "Agriculture", material: "Plants", to: "Tobacco" },
      { from: "Agriculture", material: "Plants", to: "Chemical" },
      { from: "Chemical", material: "Chemicals", to: "Agriculture" },
    ],
    exportAmount: "(IPROD+IINV/10)*(-1)",

    // Unlocks, split by urgency. Buying them as one flat list ahead of the first
    // division is what bricked the BN10 corp: a self-funded corp starts with
    // exactly $150b and its funds can NEVER be topped up from personal money, so
    // once ~$145b of unlocks are bought there's nothing left for Agriculture's
    // $40b startingCost - no division, no revenue, no way back.
    //
    // apiUnlocks are the two the SCRIPTED buildout physically needs: without them
    // getWarehouse / upgradeOfficeSize / hireEmployee / setJobAssignment all
    // throw, so nothing can be built or staffed. Free once you hold SF3.3;
    // otherwise they're the single biggest slice of the founding stake. Bought
    // immediately AFTER the first division, never before it.
    apiUnlocks: ["Warehouse API", "Office API"],
    // Everything else waits until the corp is founded, warehoused and earning.
    // Smart Supply auto-buys input materials (without it, lib/corp-market.js falls
    // back to stocking inputs by hand ). Export is only
    // useful from round 2, when Chemical exists to feed the quality loop.
    optionalUnlocks: ["Smart Supply", "Export"],
    // Earliest investment round each optional unlock may be bought in.
    optionalUnlockRound: { "Smart Supply": 1, Export: 2 },

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
    // Warehouse footprint per unit, for every material - the boost materials plus
    // the industry INPUTS (Water, Chemicals, ...) that the input stocking has to
    // size purchases against. The Material object exposes no size field, so this
    // table is the only source; values are the game's own per-unit sizes.
    materialSize: {
      "Real Estate": 0.005, Hardware: 0.06, Robots: 0.5, "AI Cores": 0.1,
      Water: 0.05, Ore: 0.077, Minerals: 0.078, Food: 0.03, Plants: 0.05,
      Metal: 0.077, Chemicals: 0.05, Drugs: 0.019,
    },
    // Share of each warehouse reserved for boost materials. The manual's own
    // round-1/2 buy lists commit 76-84% of the warehouse to boost materials -
    // the division production multiplier they feed is "the most crucial factor
    // in early rounds" (8.1). 0.6 stays a step shy of that because our orders
    // top up continuously rather than as one end-of-round buy, and production
    // needs standing headroom for outputs; sellMaterial ships them at MAX every
    // cycle, so 20% output room (with inputs at 0.2) has proven comfortable.
    boostWarehouseFraction: 0.6,
    // Product divisions get a much smaller boost slice: their warehouse also
    // holds the imported input (Plants) AND the finished-product inventory
    // waiting on sales - which move slowly before Market-TA.II - so a
    // material-division-sized boost pile leaves products nowhere to go and
    // stalls production (the clog is always in the product division first).
    productBoostWarehouseFraction: 0.3,
    // Materials are acquired with buyMaterial (a per-second purchase ORDER filled
    // during the PURCHASE state) rather than bulkPurchase, which is the single
    // biggest early-round difference the manual calls out: bulkPurchase demands the
    // full price up front, while a per-second order is allowed to take the corp
    // into DEBT. In rounds 1-2 you are supposed to spend everything on the buildout
    // and then go negative buying boost materials at the end of the round - which
    // bulkPurchase simply cannot do.
    //
    // The order rate is shortfall / materialBuySeconds. Sized to the BUILD-PHASE
    // ROTATION period (4 phases x the 15s daemon tick), not to the 10s corp cycle:
    // an order placed by one lib/corp-market.js pass keeps buying until the NEXT
    // pass reviews it, so a rate that filled the shortfall in one cycle would
    // overshoot the target ~6x before anyone cleared it. At ~60s the order finishes
    // right around the next review, which caps overshoot at roughly nothing.
    materialBuySeconds: 60,
    // Share of each warehouse reserved for manually-stocked industry inputs (only
    // used while we don't own Smart Supply ). It's a
    // working buffer, not a stockpile, but it has to survive between corp-market
    // passes (once per daemon tick) or production stalls waiting on inputs -
    // output barely competes for the space, since sellMaterial ships it at MAX
    // every cycle.
    inputWarehouseFraction: 0.2,
    // Don't re-buy while stock is within this fraction of target.
    boostShortfallTolerance: 0.02,
    // Purchase orders may never fill the warehouse past this reserved slice -
    // it's the production output's room. When the warehouse is crowded, orders
    // shrink to fit and then CLEAR rather than standing unfillable; a standing
    // order re-buys whatever space production frees, which is the congestion
    // loop that permanently stalls a division (manual 12.2).
    orderHeadroomFraction: 0.1,
    // Product divisions reserve far more: a cycle of product output plus the
    // per-cycle Plants import can overrun a thin margin, and unsold product
    // stock needs somewhere to sit without freezing the purchase pipeline.
    productOrderHeadroomFraction: 0.3,
    // Sell boost stock back down (at MP) once it exceeds target by this
    // fraction. Overshoot happens when an order outlives its review window - a
    // starved rotation slot, or bonus time running cycles 10x faster - and boost
    // materials are never consumed, so without a drain the excess squats on
    // warehouse space forever. Wide enough of a band past boostShortfallTolerance
    // that buy and sell can never oscillate.
    orderOvershootTolerance: 0.1,
    // Used when getIndustryData() is unavailable.
    defaultProducedMaterials: ["Plants", "Food"],

    // ── Employee role splits ─────────────────────────────────────────────────
    // Round 1-2 offices follow the manual's exact protocol instead of a ratio:
    // ALL employees on R&D until the division banks its RP gate (see
    // round1ResearchPoints / round2ResearchPoints), then these fixed splits -
    // written as WEIGHTS, normalised at assignment time so a hand-grown office of
    // any size still gets the same shape. Round 1 is the manual's O1/E1/B1/M1 of
    // 4; round 2 is Agriculture O3/E1/B2/M2 of 8 and Chemical O1/E1/B1 of 3.
    earlyJobs: {
      1: {
        Agriculture: { Operations: 1, Engineer: 1, Business: 1, Management: 1 },
      },
      2: {
        Agriculture: { Operations: 3, Engineer: 1, Business: 2, Management: 2 },
        Chemical: { Operations: 1, Engineer: 1, Business: 1 },
      },
    },
    // Round 3+ splits (each sums to 1.0). Material divisions run the manual's
    // Engineer-heavy "raw production" support split - in the product rounds
    // EngineerProduction matters far more than RP for material quality, and
    // Business is useless in a support office. The Tobacco design office runs the
    // "progress" split (Engineer + Management heavy) to develop products fast; its
    // support offices sit almost entirely on R&D to bank research points.
    jobsMaterialProd: {
      Operations: 0.176, Engineer: 0.506, Business: 0.0, Management: 0.118, "Research & Development": 0.2,
    },
    // The manual's round-3 "progress" sample ratio (19.4.2) - development speed
    // scales on Engineer^0.34 with a Management factor, so Business/Operations
    // get token headcount only.
    jobsProductMain: {
      Operations: 0.037, Engineer: 0.512, Business: 0.011, Management: 0.44, "Research & Development": 0.0,
    },
    // The manual's round-3+ support-office setup: 1 each in the four producing
    // jobs, everyone else on R&D. The Business seat is NOT optional - Business
    // production multiplies each city's sales volume, and a support city with
    // zero Business sells its share of the product at a crawl, which is how
    // product stock piles up and clogs the warehouse.
    jobsProductSupport: {
      "Research & Development": 0.8, Operations: 0.05, Engineer: 0.05, Business: 0.05, Management: 0.05,
    },

    // Per-round Agriculture buildout ceilings (office size, warehouse level,
    // Advert level), seeded from the guide's standard strategy; past round 4 we
    // build to agriTargetsMax. Every step is affordability-gated.
    agriTargets: {
      1: { office: 4, warehouse: 4, advert: 2 },
      2: { office: 8, warehouse: 17, advert: 8 },
      3: { office: 9, warehouse: 20, advert: 10 },
      4: { office: 12, warehouse: 25, advert: 12 },
    },
    agriTargetsMax: { office: 18, warehouse: 30, advert: 15 },
    // Chemical is a support division: keep it tiny (guide: don't waste funds on
    // its office/advert - it only needs to produce enough high-quality Chemicals
    // to feed the quality loop). No Advert ever.
    chemicalTargets: {
      1: { office: 3, warehouse: 2, advert: 0 },
      2: { office: 3, warehouse: 2, advert: 0 },
      3: { office: 6, warehouse: 4, advert: 0 },
      4: { office: 9, warehouse: 6, advert: 0 },
    },
    chemicalTargetsMax: { office: 12, warehouse: 8, advert: 0 },
    // Chemical only earns its $70b startingCost once its Chemicals can be exported
    // back into Agriculture, which needs the (round 2) Export unlock. Founded from
    // the start it just competes with Agriculture for the founding stake - and on a
    // self-funded corp there is no spare stake to compete for.
    chemicalStartRound: 2,
    // Tobacco is the profit engine, so these are the main growth knobs. They're
    // only ceilings: every office/warehouse step is affordability-gated, so a
    // small corp grows slowly toward them and a rich one keeps scaling.
    // Warehouse ceiling raised past the old 16: the manual (6.3, 15.1) calls
    // warehouse space a serious late bottleneck - every product needs room for
    // its inputs AND its output - and these are affordability-gated ceilings, so
    // the higher number costs nothing until the corp can pay for it.
    tobaccoTargets: { designOffice: 60, supportOffice: 20, warehouse: 24 },

    // Tobacco (the product/profit division) is created once the two Agriculture-
    // funded rounds are banked, i.e. from round 3 (guide).
    tobaccoStartRound: 3,
    // Investment-round gates: rounds 3 and 4 are only accepted once Tobacco has
    // developed this many finished products (the guide's "1P/2P" cadence -
    // 1 product before round 3, 2 before round 4).
    productsBeforeRound: { 3: 1, 4: 2 },

    // Bought in strict order - never skip ahead to a cheaper later one. This IS
    // the manual's recommended order: Hi-Tech R&D Laboratory first (it boosts RP
    // gain and is the prerequisite for everything else), then Market-TA.I+II for
    // automatic optimal pricing (TA.I is worthless except as TA.II's prereq), then
    // the energy/morale and employee-stat researches, and only then production.
    // That ordering is deliberate: the manual is explicit that stat/morale research
    // beats production research, which is merely "nice to have".
    //
    // Deliberately absent, per the manual's "useless" list: AutoBrew and
    // AutoPartyManager (lib/corp-upkeep.js does that job better and for money
    // rather than RP), uPgrade: Dashboard, both HRBuddy researches, and
    // uPgrade: Capacity.I/II (more product slots cost warehouse space and input
    // materials for products that are strictly worse than the newest one).
    researchPriority: [
      "Hi-Tech R&D Laboratory",
      "Market-TA.I",
      "Market-TA.II",
      "Overclock",
      "Sti.mu",
      "Automatic Drug Administration",
      "Go-Juice",
      "CPH4 Injections",
      "Drones",
      "Drones - Assembly",
      // 1.5x warehouse storage, and storage is a hard bottleneck late (every
      // product slot needs space for its inputs and its output).
      "Drones - Transport",
      "Self-Correcting Assemblers",
      "uPgrade: Fulcrum",
    ],
    // Never spend more than this share of the RP POOL on one research. The manual's
    // rule, split by category: RP is also what product rating keys off, so draining
    // the pool - especially just before a product finishes - costs more than the
    // research returns. The three PRIORITY researches (the lab and the two
    // Market-TAs) get the manual's general half-the-pool bar, since TA.II is the
    // single biggest round-3+ upgrade going; stat research the stricter 20%;
    // production research 10%, because it's the least valuable category.
    researchMaxPoolFraction: { priority: 0.5, stat: 0.2, production: 0.1 },
    // Tier membership for the thresholds above; anything in researchPriority not
    // named here counts as "stat".
    researchPriorityTier: ["Hi-Tech R&D Laboratory", "Market-TA.I", "Market-TA.II"],
    // Researches that must be affordable TOGETHER before the first one is
    // bought. Market-TA.I is useless alone (it exists only as TA.II's
    // prerequisite), and the RP it drains is product rating in the meantime -
    // the manual says to stock up and buy the pair in one go (~150k pool for
    // the 70k pair under the half-pool cap).
    researchBundle: { "Market-TA.I": ["Market-TA.II"] },
    researchProduction: [
      "Drones", "Drones - Assembly", "Drones - Transport",
      "Self-Correcting Assemblers", "uPgrade: Fulcrum",
    ],
    // No research at all before this round. RP gain in round 3 is too low for any
    // purchase to pay for itself, so the pool is better banked toward product
    // rating and then spent from round 4 (manual 19.4.2).
    researchFromRound: 4,

    // ── Per-cycle employee upkeep (lib/corp-upkeep.js) ───────────────────────
    // Energy and morale multiply EVERY office output: ProductionBase = AvgMorale *
    // AvgEnergy * 1e-4 (manual 10.4), which feeds RP, material quality, product
    // stats, raw production and max sales volume. Letting them sag is a silent,
    // compounding tax on the whole corp, so the manual calls topping them up every
    // cycle mandatory. It runs in its own always-on script precisely so it keeps
    // working while you drive the corp by hand.
    upkeep: {
      // Top up whenever the office is more than this below its maximum. The manual
      // tops up at 99.5/100; expressed as slack it keeps working when Go-Juice /
      // Sti.mu raise the maxima past 100 (office.maxEnergy / maxMorale are read
      // live rather than assuming 100).
      slack: 0.5,
      // Ceiling on party cost per employee. Not a safety rail so much as a
      // deliberate strategy: the manual shows one big 70->100 party costs more than
      // three small ones (70->80->90->100), so capping the per-cycle spend splits
      // an expensive recovery into cheaper steps. Only ever binds on a brand-new or
      // long-neglected office; a per-cycle top-up costs ~65k/employee.
      maxPartyCostPerEmployee: 1e6,
      // Offices below this many employees don't decay at all - PerfMult is 1.002,
      // i.e. energy/morale drift UP (manual 10.3). Used by the PerfMult term in the
      // optimal-party-cost solve, not as a skip: topping up a tiny office is cheap
      // and gets a new office to max faster.
      decayMinEmployees: 9,
      // The two PerfMult terms we can't read directly. 0.018 = 0.002 * 9, the
      // intern coefficient; 0.001 is the penalty applied when the corp is in debt
      // AND the division is losing money (manual 10.3).
      internCoefficient: 0.018,
      debtPenalty: 0.001,
    },

    // Product-round advertising. Each cycle we buy a Wilson Analytics level if
    // affordable from last cycle's profit, then spend at least this fraction of
    // funds on Advert for the product division (guide: the main profit driver in
    // round 3+).
    wilsonUpgrade: "Wilson Analytics",
    advertFundsFraction: 0.2,
    // The manual's thresholdOfFocusingOnAdvert (19.4.2): once profit clears
    // ~1e18/s, Advert's benefit outweighs its cost so decisively that at least
    // 20% - and personally, the author, up to 60% - of funds should go to it.
    // Past the threshold we step the fraction up rather than tuning an optimizer.
    advertFocusProfit: 1e18,
    advertFocusFraction: 0.5,

    // Corp-wide levelable upgrades, cheapest-affordable-first within budget.
    // Wilson Analytics is deliberately NOT here - it's driven per-cycle by
    // manageWilsonAdvert (Tobacco-gated) so it isn't bought before the product
    // rounds (guide: don't buy Wilson in round 2).
    upgradePriority: [
      "Smart Storage",
      "Smart Factories",
      "FocusWires",
      "Neural Accelerators",
      "Speech Processor Implants",
      "Nuoptimal Nootropic Injector Implants",
      "ABC SalesBots",
      "Project Insight",
    ],
    // Rounds 1-2 override: the manual (6.2) is explicit that Smart Storage (and,
    // in round 2, Smart Factories) are the ONLY corp-wide upgrades worth buying
    // early - and the stat upgrades' 1e9 base price undercuts Smart Storage's
    // 2e9, so the cheapest-first loop above would otherwise spend the tiny early
    // budget on exactly the upgrades the manual says to skip.
    upgradePriorityByRound: {
      1: ["Smart Storage"],
      2: ["Smart Storage", "Smart Factories"],
    },

    // Never spend below this share of funds.
    fundsReserveFraction: 0.1,
    // Per-tick upgrade budget, as a share of the spendable remainder.
    upgradeBudgetFraction: 0.4,

    // Product pipeline.
    productPrefix: "Tobacco-v",
    // 1% of funds, per the manual: DesignInvestment and AdvertisingInvestment are
    // raised to the power 0.1 inside the product formula, so they scale appallingly
    // badly - doubling the spend buys ~7% more. Money is worth far more in Advert
    // and office upgrades.
    productInvestFraction: 0.01,
    productInvestCap: 1e12,
    // Below this a product isn't worth developing yet.
    productInvestMin: 1e9,
    // Used when getDivision().maxProducts is unavailable.
    maxProductsFallback: 3,

    // ── Round gates the manual makes mandatory ────────────────────────────────
    // Round 1: put the whole starting office on R&D until it has banked this much
    // RP, THEN switch to a producing split and buy boost materials. RP bought this
    // early is free quality on everything the division ever makes.
    round1ResearchPoints: 55,
    // Round 2: do not accept the offer until both divisions have banked this much
    // RP. The manual calls waiting here mandatory - RP is what makes Plants and
    // Chemicals high-quality, and quality is what makes them sellable at all. They
    // reach these numbers at roughly the same time.
    round2ResearchPoints: { Agriculture: 700, Chemical: 390 },

    // ── Dummy divisions (manual 18.5) ─────────────────────────────────────────
    // Valuation scales as (1.1^(1/12))^NumberOfOfficesAndWarehouses, so a division
    // sitting in all 6 cities with 6 warehouses multiplies valuation - and
    // therefore the investment offer - by ~1.1, for a flat 10b industry cost and
    // nothing else. Restaurant is the cheapest sane pick (Spring Water is the same
    // price but a newbie trap). They exist ONLY to inflate the offer: 6 cities, 6
    // warehouses, no office/advert/warehouse upgrades ever.
    dummy: {
      enabled: true,
      industry: "Restaurant",
      namePrefix: "Dummy",
      // Each full dummy adds 12 to the valuation exponent (~1.1x the offer), and
      // they compound: 6 of them is ~1.77x. Still comfortably inside the
      // division cap (20 in BN3, 15 in penalised nodes) next to our 4 real
      // divisions, and maxSpendFraction keeps them strictly surplus-funded.
      count: 6,
      // Not before this round: in rounds 1-2 that 10b is needed for the real
      // buildout, and the offer multiplier is worth far less on a small valuation.
      fromRound: 3,
      // Only build them out of genuine surplus - they earn nothing themselves.
      maxSpendFraction: 0.05,
    },

    // Investment rounds we farm before going public + switching to dividends.
    // The guide says take all four - rounds 3 and 4 are the huge ones.
    investmentRounds: 4,
    // Escape hatch for a capital-starved corp. The per-round agriTargets assume a
    // BN3 seed-funded start; a self-funded $150b corp that also had to buy the two
    // API unlocks can't reach round 1's "all six cities at office 4 / warehouse 4"
    // on its own, and would otherwise sit on a tiny profitable Agriculture forever
    // instead of taking the investment that pays for the rest of the buildout. So
    // rounds 1-2 also accept once the buildout is STALLED (no affordable next step)
    // and the standing offer is at least this multiple of current corp funds - i.e.
    // only when the offer is genuinely transformative, never as a cheap sellout.
    investStallOfferMult: 5,
    // Take the corp public once past the investment rounds, issuing 0 new shares
    // (guide FAQ: issue 0). issueDividends is a no-op on a private corp, so this
    // is what actually starts paying the player.
    goPublic: true,
    sharesToIssue: 0,
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

    // ── Journal cadence for repeated purchases ───────────────────────────────
    // Discrete milestones (division founded, round accepted, product finished,
    // research bought) always hit the journal immediately. Repeated spends are
    // accumulated (lib/corp-lib.js accumulateJournal) and emitted as one summary
    // line at most this often - raw, they'd drown the 400-line journal buffer.
    journal: {
      buysMs: 60_000,       // corp-steady: Wilson + Advert + corp-wide upgrade levels
      buildMs: 120_000,     // corp-expand/office: warehouse levels, office seats, hires
      ordersMs: 300_000,    // corp-market: boost/input purchase-order activity
      upkeepMs: 600_000,    // corp-upkeep: tea/party rollup
    },
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
      // Journal inline-highlight colors (ui/journal.js): augmentation names,
      // faction names, and numbers (% / $) each get their own hue so they read
      // apart at a glance. Faction is a lighter purple than the base `purple`.
      augHl: "#22d3ee",      // augmentations - cyan
      factionHl: "#d8b4fe",  // factions - light purple
      numHl: "#facc15",      // percentages + money - yellow
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
      // another progressStepPct milestone (so ~one line per 10%). progressMs is
      // the fallback for goals with no clean %: at most one line per interval.
      progressStepPct: 10,
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
    // Servers whose backdoor status is worth tracking (the world daemon is
    // finished by lib/backdoor.js, not tracked here).
    backdoorChecklist: [
      { server: "CSEC", label: "CyberSec" },
      { server: "avmnite-02h", label: "NiteSec" },
      { server: "I.I.I.I", label: "The Black Hand" },
      { server: "run4theh111z", label: "BitRunners" },
      { server: "The-Cave", label: "The Cave" },
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

  10: {
    name: "Digital Carbon",
    paths: { daemon: "/bn10/daemon.js" },
    // BN10 ends ONLY by the player backdooring w0r1d_d43m0n by hand. Two independent
    // locks enforce that, because the plannedNextBN halt sentinel alone was not one:
    // it holds lib/finish-bn.js back, but lib/backdoor.js would still have installed
    // the backdoor on the world daemon the moment hacking level allowed, and that
    // backdoor IS the finish (it opens the BitVerse). skipFinalHost takes the world
    // daemon off the backdoor list for the whole node and hard-refuses the finisher,
    // so nothing the bot does can end the run before the sleeve shop is bought out.
    backdoor: { skipFinalHost: true },
    // No multiplier overrides: BN10's ordinary hack/aug/faction economy runs
    // exactly like BN4. What's unique is duplicate sleeves - bought from The
    // Covenant and driven by lib/sleeves.js (launched off-home by bn10/daemon.js).
    // The daemon deliberately does NOT auto-destroy w0r1d_d43m0n (plannedNextBN
    // returns the halt sentinel): the whole point of BN10 is to stay and buy
    // EVERY sleeve + max memory on your first pass, since the sleeve shop only
    // exists here. Finish manually once the sleeve roster is complete.
    //
    // Once the joined-faction augs run dry, grind megacorp reputation to unlock the
    // corporation factions and their augs (pursueCompanyFactions).
    factions: { pursueCompanyFactions: true, companyWorkNeedsCity: true },

    // BN10 is the ONLY node where The Covenant sells sleeves and memory, and buying
    // out that shop is the entire reason to be here - a sleeve bought now earns for
    // the rest of the run, and memory is the one upgrade that carries into every
    // future BitNode. Everything else (servers, NeuroFlux, a marginal aug) can be
    // re-earned in any node; these can't. So the shop budgets go from "a slice of
    // cash" to "nearly all of it": we buy a sleeve at ~1.1x its price instead of
    // waiting for 2x, and push memory and sleeve augs just as hard. lib/sleeves.js
    // resolves these through forNode(), so they only apply here.
    sleeves: {
      buyMaxSpendFraction: 0.9,
      memoryMaxSpendFraction: 0.9,
      augMaxSpendFraction: 0.5,
      // No early-game floor to respect: by the time BN10's shop matters we're long
      // past worrying about TOR money, and sleeve augs are pure compounding here.
      augMinMoney: 0,
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
