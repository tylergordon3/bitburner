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

// ── Crime constants ──────────────────────────────────────────────────────────
// The game's own per-crime base values (src/Crime/data/Crimes.ts): attempt
// duration, karma per success, base money per success. No multiplier touches
// time or karma, and money is scaled by the same player/BitNode multipliers for
// every crime, so for choosing BETWEEN crimes (lib/crime-logic.js) these are all
// that's needed - which is what lets the daemons and lib/grafting.js drop
// ns.singularity.getCrimeStats (5GB each). Shared by the player's crime pick
// (lib/player-actions.js), the grafter's opportunity cost, and the sleeves.
const CRIMES = {
  timeMs: { Homicide: 3_000, Mug: 4_000 },
  karma: { Homicide: 3, Mug: 0.25 },
  money: { Homicide: 45_000, Mug: 36_000 },
};

// ── Shared defaults ──────────────────────────────────────────────────────────

export const CONFIG = {
  crimes: CRIMES,
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
    // The Covenant's sleeve + memory shop, BN10 only (see lib/sleeve-shop.js).
    sleeveShop: "/lib/sleeve-shop.js",
    grafting: "/lib/grafting.js",
    contracts: "/lib/contracts.js",
    // IPvGO player (every node, no Source-File needed) - see the `go` section.
    go: "/lib/go.js",
    // One-shot: publishes every aug's stat multipliers (see augs.value).
    augStats: "/lib/aug-stats.js",
    econ: "/lib/econ.js",
    // Hacknet SERVER manager (BN9 / SF9): fleet growth + hash spending, off-home.
    hacknet: "/lib/hacknet.js",
    // Bladeburner (BN6/7 or SF6/7), split in two off-home helpers for RAM: the
    // action loop the player's slot depends on, and the slower skills/city/faction
    // upkeep that can wait for a host.
    bladeburner: "/lib/bladeburner.js",
    bladeUpkeep: "/lib/blade-upkeep.js",
    // Cold-boot one-shot: gym to the division's join gate and join, while
    // early/driver.js is still growing home toward the daemon.
    bladeBoot: "/early/blade-boot.js",
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
    // The HUD-header toggles, persisted (see lib/toggles.js for why, and
    // ui/dashboard.js for the buttons). Each holds the literal string "on" or "off";
    // anything that isn't "off" reads as on, so a missing file is the old behaviour.
    //   focusFile      - AUTO-FOCUS. Off => work goes out unfocused so the game
    //                    stops pinning the UI to its work screen. Owned by
    //                    lib/player-actions.js (focusFlag).
    //   autoFinishFile - AUTO-FINISH. Off => the daemon runs exactly as normal and
    //                    backdoors the faction servers, but never ends the node
    //                    (the bot never backdoors w0r1d_d43m0n; that is the finish). Owned
    //                    by lib/daemon-lib.js (ensureBackdoorHelpers).
    //   autoCorpFile   - AUTO-CORP. Off => no corp script is deployed and any that
    //                    are running get killed, so the corporation is entirely the
    //                    player's to run by hand. Owned by lib/corp-daemon.js.
    focusFile: "/data/auto-focus.txt",
    autoFinishFile: "/data/auto-finish.txt",
    // The next-BitNode daemon arg, remembered across aug installs (the reset
    // callback restarts the daemon without args) - lib/daemon-lib.js nextBNOverride.
    nextBnFile: "/data/next-bn.txt",
    autoCorpFile: "/data/auto-corp.txt",
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
    // Only the FALLBACK: the manager asks the game (ns.weakenAnalyze(1)), because
    // the ServerWeakenRate BitNode multiplier scales this - 0.1 in BN11 (x2),
    // 0.05 / 1.02^level in BN12, 0.05 in every other node.
    weakenAmount: 0.05,
    // Landing gap between the H/W/G/W legs of a batch. Legs land at W-2s, W,
    // W+2s, W+3s (see legSchedule), so one batch's landings span 5 gaps.
    batchSpacingMs: 200,
    // Extra gap between one batch's last landing and the next batch's first.
    // Launch interval = span + this, which is what keeps batches from
    // interleaving as leg times shrink with hacking level / timers jitter.
    launchMarginMs: 200,
    // A batch may launch this long before the last moment that would still reach
    // its landing window (the extra is added to every leg's delay). That slack is
    // what lets a launch wait out the few hundred ms in which another batch's
    // hack or grow has security raised, without its window slipping.
    launchLeadMs: 1_000,
    // Ceiling on batches in flight per target (each is 4 processes). Past it the
    // launch interval stretches and batches get fatter instead of more numerous.
    maxDepth: 60,
    // Slack added after a batch's last planned landing before its RAM is
    // considered released (covers exec/timer jitter).
    landingPadMs: 500,
    // Kept free on home so the daemon and its children always have room.
    reserveHomeRam: 8,
    // Used before the real getScriptRam() readings land in main().
    fallbackRam: { hack: 1.7, grow: 1.75, weaken: 1.75 },
    // The most of a target's money one batch may steal. The scheduler fixes how
    // many batches are in flight from timing alone, then sizes each one - to the
    // hack thread - as the fattest batch that fits (the target's RAM / depth), up
    // to this. Fatter bites cost more grow per dollar (restoring a 50% bite takes
    // ~6.6x the grow threads of a 10% one, for 5x the money), so past this the RAM
    // is better spilled onto the next target.
    maxHackFraction: 0.5,
    // Extra grow threads per batch, as a fraction of the exact count. A batch's
    // grow only repairs its own hack, so with the exact count any shortfall (the
    // hacking level rising while the batch is in flight makes its hack land a
    // little stronger than planned) persists and stacks until the drift check
    // drains the target; a slightly generous grow closes the gap instead. 2%
    // costs ~0.3% of income and rode out a level-up every ~30s without a drain.
    growPadding: 0.02,
    // How many targets the botnet batches at once, in rank order, each getting
    // the RAM the ones above it don't need.
    //
    // One target has a hard income ceiling: timing alone fixes the launch
    // interval (~span + margin), so it pays at most maxHackFraction of its money
    // per interval no matter how much RAM we throw at it. A big botnet against a
    // small server - the normal case at a low hacking level, where n00dles is the
    // best thing in reach - therefore leaves most of the fleet idle. Spilling the
    // remainder onto the next-best targets is what fills it.
    maxTargets: 6,
    // The edge a target with batches in flight gets when the botnet's RAM is
    // re-split (a multiplier on its income per GB). Dropping a prepped target
    // for a marginally better unprepped one costs a prep; this is the margin
    // the newcomer has to clear.
    targetStickiness: 0.15,
    // How far ahead a target is judged when it would first have to be prepped:
    // its income per GB is scaled by horizon / (horizon + estimated prep time).
    // Short horizons keep a small fleet on quick-to-prep servers; long ones let
    // it invest in a rich server that takes an hour to grow.
    prepHorizonMs: 60 * 60 * 1_000,
    // Spare RAM below this isn't worth opening another target for (a batch plus
    // room to prep it).
    minTargetRam: 64,
    // A target counts as "prepped" within this much of min security and this
    // fraction of max money. Tight on purpose: leg durations scale with security,
    // and the batch ordering guarantee assumes the prepped timings.
    prepSecurityTolerance: 0.1,
    prepMoneyThreshold: 0.95,
    prepSleepPadMs: 1_000,
    waitForRamMs: 2_000,
    // Drift check while batches are in flight: the open batch explains a money
    // dip of its fraction and a security rise of its added security; anything
    // beyond that plus these tolerances means the ordering broke (or someone
    // else is hacking the target) - stop launching, let the window drain, re-prep.
    driftMoneyTolerance: 0.05,
    driftSecurityTolerance: 0.1,
    // Throttle on the journal warning for "no target scored above zero" - the
    // manager ticks 5x a second, and this is a state that can persist.
    idleWarnMs: 5 * 60 * 1_000,
    // Cadences for the expensive scans; none of these change tick to tick.
    networkRescanMs: 5_000,   // ns.scan walk of the whole network
    rootRetryMs: 5_000,       // retry rooting unrooted servers
    targetRescoreMs: 10_000,  // re-rank hack targets
    // Hacknet servers show up as rooted RAM but are terrible hack targets.
    excludeTargetPrefix: "hacknet-server",
  },

  // hacking/manager.js - faction-rep sharing (ns.share), a side mode of the
  // botnet. While the daemon is farming faction rep, dedicate a small, capped
  // slice of the botnet to ns.share(), which multiplies faction-WORK rep gain by
  //   1 + ln(1 + effectiveShareThreads) / 25
  // (Bitburner's formula - its thread counter starts at 1; effectiveThreads ≈
  // threads on 1-core servers). That
  // curve is steeply diminishing - each DOUBLING of share threads adds only
  // ln(2)/25 ≈ +2.8 percentage points - so a couple of servers captures most of
  // the benefit while the rest of the botnet keeps earning. The manager owns
  // this so share + hacking draw from one RAM plan (no reservation handshake).
  //
  // How the count is derived (see hacking/manager.js manageShare):
  //   1. budget = fraction × (eligible network RAM), i.e. "use a slice, not all"
  //   2. capped by targetBonus: past a target multiplier the curve is too flat
  //      to justify the money-RAM. threads_for(B) = e^(25·(B−1)) − 1; RAM = that ×
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
    // Share only takes FREE RAM - it never evicts the botnet's legs - so a busy
    // host is filled in top-ups as those legs land. A top-up waits until at
    // least 1/this of the host's plan fits, which bounds the share processes a
    // host ends up running.
    maxProcessesPerHost: 8,
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
    // Loop guard on one call's purchases (each is the best RAM per dollar on
    // offer - see lib/pserv.js).
    maxBuysPerCall: 60,
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
    // The cheap early-game hacknet NODE buyer below. Off where lib/hacknet.js runs
    // the fleet instead (BN9: hacknet servers are the node's whole economy, and
    // this routine's 8-node / hack-200 caps would fight it for the same money).
    hacknetNodes: true,
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

  // lib/hacknet.js - the hacknet SERVER manager (BitNode 9 / SF9), run off-home.
  // Two loops: grow the fleet by best marginal hash-rate per dollar within a
  // payback horizon, and spend the hashes (lib/hacknet-logic.js decides both).
  // Everything here is a default; BITNODE[9] turns the budgets up, since there
  // the fleet IS the economy.
  hacknet: {
    tickMs: 3_000,
    // Master switch: the daemon core launches the helper only where this is on
    // (BN9 sets it), and early/driver.js starts it during the cold boot there too.
    enabled: false,
    // Share of SPENDABLE cash (above gordMoneyFloor and reserveMoney) the fleet
    // may spend per tick. The payback cap below is the real brake.
    spendFraction: 0.25,
    reserveMoney: 1e6,
    // An upgrade is bought only if its cost is recovered - at the "Sell for
    // Money" rate - within this long. Early upgrades pay back in seconds; a maxed
    // fleet's last cores pay back in days, which is where buying stops.
    maxPaybackMs: 3 * 60 * 60 * 1_000,
    // ...and while the daemon is saving for an aug (hints.savingMoney > 0), only
    // upgrades that pay back this fast - they delay the aug by less than they
    // speed up everything after it.
    savingPaybackMs: 30 * 60 * 1_000,
    // Fleet caps (the game's own are 20 servers, level 300, 8TB, 128 cores,
    // cache 15); lower these to stop short.
    maxServers: 20,
    // Hash spending. "Sell for Money" is the universal sink; the investments are
    // the hash upgrades that make the node beatable (see lib/hacknet.js):
    //   studying / gym  - +20% per level to study / gym exp, while the player is
    //                     doing exactly that (hacking level is BN9's real gate).
    //   target boosts   - Reduce Minimum Security / Increase Maximum Money on the
    //                     botnet's primary target (its money is 0.1% of normal in
    //                     BN9 until these compound).
    //   contracts       - Generate Coding Contract, for lib/contracts.js to solve.
    //   corp funds      - "Sell for Corporation Funds" ($1e9 per ~100 hashes vs
    //                     $25M sold) - only pays off if the corp turns funds into
    //                     dividends, so opt-in.
    spend: {
      // An investment is only WAITED for while it costs at most this share of
      // hash capacity; dearer ones are skipped (cache upgrades raise capacity).
      investMaxCapacityFraction: 0.5,
      // Never sit on a full cache: above this fill, sell down regardless of any
      // investment we were saving toward.
      sellAboveCapacityFraction: 0.9,
      studyMaxLevel: 150,
      gymMaxLevel: 50,
      // Stop boosting a target past these (max money soft-caps at $1e13 in-game).
      boostMaxMoney: 1e12,
      boostMinSecurity: 1,
      contractsPerHour: 6,
      contractMaxCost: 400,
      corpFunds: false,
    },
    // Hacknet servers are rooted RAM the botnet would otherwise fill; running
    // scripts on one cuts its hash rate in proportion (ramUsed / maxRam). Off =
    // reserved for hashes; on = the botnet may use them like any host.
    botnetMayUse: false,
    // Lose-nothing install: hashes are wiped by an aug install, so the daemon asks
    // the helper to sell them all first and waits at most this long for it.
    installDumpTimeoutMs: 30_000,
  },

  // lib/bladeburner.js (the action loop) + lib/blade-upkeep.js (skills, city,
  // faction), both off-home; the decisions are the pure lib/bladeburner-logic.js.
  // Only bn6/daemon.js launches them. See those files' headers for the contract
  // with the daemon (gordBladeControl in, gordBladeState / gordBladeUpkeep out).
  //
  // Mechanics these knobs are tuned against (bitburner-src, src/Bladeburner/):
  //   - success = competence / difficulty. Competence scales with
  //     (city population / 1e9)^0.7 and with min(1, stamina / (0.5 * maxStamina));
  //     difficulty scales with sqrt(1 + chaos - 50) above 50 chaos.
  //   - stamina regenerates passively at (0.0085 + max/70000) * agility^0.17 per
  //     second whatever you do, and the Regeneration Chamber adds 1% of max per
  //     60s on top. That sounds small and isn't: passive regen is ~3%/min of max
  //     at agility 100 but under 1%/min once max stamina is in the hundreds, so
  //     the chamber roughly DOUBLES the regen rate mid-node (restInChamber).
  //   - stamina belongs to the division, not to whoever acts: a SLEEVE in the
  //     chamber adds the same 1% of the player's max per 60s (completeAction is
  //     called with the sleeve as the person). See sleeves.blade.regenBelow.
  //   - Field Analysis, Recruitment, Diplomacy and Incite Violence cost no stamina.
  //   - Incite Violence adds 10 + chaos/log10(chaos) chaos to EVERY city (0 -> 20
  //     -> 50 -> 94 -> 156) for 3/8 of a growth roll of attempts, and Diplomacy
  //     takes back ~1.3% of the current city's chaos per 60s. Never worth it.
  //   - Operation/black-op success gets (team + 1)^0.05 from the team; a black op
  //     always costs at least one member, a successful op up to half the team.
  bladeburner: {
    // Whether this node runs Bladeburner at all. On: early/driver.js gyms to the
    // join gate and joins during the cold boot (the division - rank, skills - is
    // reset by every NEW BitNode, though not by an aug install).
    enabled: false,
    // Action-loop poll. A contract takes seconds to minutes, so this only has to
    // be fast enough to start the next action promptly after one lands.
    tickMs: 1_000,
    upkeepTickMs: 10_000,
    // Joining the division needs 100 in every combat stat (base skill levels),
    // plus BN6/BN7 or SF6/SF7. No location requirement.
    joinStats: { strength: 100, defense: 100, dexterity: 100, agility: 100 },
    bootTickMs: 10_000,
    // Once joined, early/blade-boot.js leaves this running (actions repeat by
    // themselves) until the daemon's action loop takes over: stats and max
    // stamina, for a tiny stamina cost that passive regen more than covers.
    bootAction: "Training",
    // The faction you join through the division, once rank reaches factionRank.
    faction: "Bladeburners",
    factionRank: 25,
    // This aug lets Bladeburner actions run alongside ordinary work; once it's
    // INSTALLED the daemon stops sharing the player's slot and runs both.
    simulacrumAug: "The Blade's Simulacrum",
    // The black op that ends the BitNode. Only started when the daemon says the
    // node may finish (FINISH toggle on AND a next BitNode is planned).
    finalBlackOp: "Operation Daedalus",
    // Without a daemon arg, the node re-enters ITSELF after Daedalus while the
    // Source-File level this run awards is below this (lib/bladeburner-logic.js
    // plannedNodeAfterBlade). 0 = halt for a manual choice, which is BN6's
    // default; BITNODE[7] sets 3 because SF7.3 is the level that hands out The
    // Blade's Simulacrum on joining. The HUD's FINISH toggle still holds either way.
    reenterUntilSF: 0,

    // ── Stamina ────────────────────────────────────────────────────────────────
    // Below half of max stamina every action's success chance is penalised, so
    // rest well before that and don't stop resting until nearly full (hysteresis:
    // one rest phase, not a flicker on the line).
    restBelow: 0.55,
    resumeAbove: 0.95,
    // Failed actions cost HP; rest (the regen chamber heals) below this.
    hpRestBelow: 0.5,
    // While resting, the player's slot may go to faction work for the best
    // non-Bladeburner rep target - stamina recovers passively either way, so the
    // rest phase becomes free reputation.
    factionWorkWhileResting: true,
    // Otherwise a rest phase is spent (lib/bladeburner-logic.js restAction): in
    // the Regeneration Chamber while HP is low, on Diplomacy for a chaotic city,
    // on Field Analysis while estimates are loose, then in the chamber again -
    // it shortens the rest itself (see the mechanics note above), and a shorter
    // rest is more contracts and operations. Turn restInChamber off to spend
    // rests on Recruitment (while it succeeds at least recruitMinChance of the
    // time) and Field Analysis instead.
    restInChamber: true,
    recruitMinChance: 0.5,
    // Put the whole team on each black op (+(team+1)^0.05 success). Ordinary
    // operations stay solo: a SUCCESSFUL one can still kill up to half the team.
    teamOnBlackOps: true,

    // ── Action choice ─────────────────────────────────────────────────────────
    // Contracts and operations considered, by the lowest estimated success chance
    // (the pessimistic end of the game's [min, max] estimate). Raid is left out:
    // it fails outright in a city with no Synthoid communities and raises chaos.
    contracts: ["Tracking", "Bounty Hunter", "Retirement"],
    operations: ["Investigation", "Undercover Operation", "Sting Operation", "Stealth Retirement Operation", "Assassination"],
    // These two SPEND the city: each success permanently removes 0.5% (Stealth
    // Retirement) or 0.1% (Sting) of its Synthoid population, and every action's
    // success scales with (population / 1e9)^0.7. So they only run while the
    // current city's estimated population is above the floor - the surplus is
    // harvested, the base isn't (lib/bladeburner-logic.js conservePopulation).
    // 1e9 is the game's own reference point, where the population factor is 1.
    populationOps: ["Sting Operation", "Stealth Retirement Operation"],
    populationFloor: 1e9,
    // Never attempt an action below this chance - a failure costs rank and HP.
    minChance: 0.8,
    // Keep the running action unless another beats it by this margin; starting an
    // action throws away the progress of the one in flight.
    stickyMargin: 0.9,
    // Per-action level control (autolevel off): step down while the chance is
    // under minChance, step up once it clears raiseChance. Higher levels pay more
    // rank per success; the gap between the two bars stops it oscillating.
    raiseChance: 0.95,
    // Black ops are one-shot and a failure is expensive, so they get a stricter bar.
    blackOpMinChance: 0.9,
    // Field Analysis sharpens the success estimate; worth doing when the best
    // candidate's [min, max] estimate is wider than this.
    analysisSpread: 0.1,
    // Chaos above this in our city penalises every action: run Diplomacy.
    chaosDiplomacy: 50,
    // Everything exhausted (no contract/op counts left): Incite Violence would
    // refill the counts, but it raises chaos in EVERY city by 10 + chaos/log10(chaos)
    // - the third use puts all six past the 50 threshold, where difficulty scales
    // with sqrt(chaos - 49), and Diplomacy only repairs the city we're in at ~1.3%
    // a minute. Off: an exhausted division trains while the sleeves infiltrate.
    inciteWhenExhausted: false,

    // ── City (lib/blade-upkeep.js) ─────────────────────────────────────────────
    cities: ["Sector-12", "Aevum", "Volhaven", "Chongqing", "New Tokyo", "Ishima"],
    // Move to the most populous city (more Synthoids = better odds), but only for
    // a real gain; switching is free, flip-flopping on estimate noise is not.
    citySwitchMargin: 0.2,
    // Never move into a city this chaotic.
    cityMaxChaos: 50,

    // ── Skills (lib/blade-upkeep.js) ───────────────────────────────────────────
    // Each skill point buys the level with the lowest cost/weight, so levels end
    // up spread roughly in proportion to these weights. cap = our own ceiling
    // (the game's hard caps, e.g. Overclock's 90, are honoured regardless).
    // Overclock sits level with Blade's Intuition: -1% action time per level is
    // worth more the higher it goes (level 89 -> 90 is +10% actions per second),
    // and it's the one skill both well-known public scripts buy first. Short-Circuit
    // covers every kill action - which is most of the black ops as well as
    // Retirement, Bounty Hunter and Assassination - so it ranks with the
    // operation-wide Digital Observer rather than with Cloak.
    skills: {
      "Blade's Intuition": { weight: 3 },   // +3% success, every action
      "Overclock":         { weight: 3 },   // -1% action time (game cap 90)
      "Digital Observer":  { weight: 2 },   // +4% success, operations + black ops
      "Short-Circuit":     { weight: 2 },   // +5.5% success, kill actions
      "Cloak":             { weight: 1.5 }, // +5.5% success, stealth actions
      "Reaper":            { weight: 2 },   // +2% every combat stat
      "Evasive System":    { weight: 2 },   // +4% dex/agi
      "Tracer":            { weight: 1, cap: 20 },  // +success, contracts only
      "Cyber's Edge":      { weight: 1 },   // +max stamina
      "Hyperdrive":        { weight: 1 },   // +Bladeburner exp
      "Hands of Midas":    { weight: 0.5 }, // +contract money
      "Datamancer":        { weight: 0.25 },
    },
    // Loop guard on one upkeep pass's skill purchases.
    maxSkillBuysPerTick: 200,
    // gordBladeControl older than this means the daemon is gone; the action loop
    // then treats the slot as its own (Bladeburner is the node's default work).
    controlStaleMs: 60_000,
  },

  // lib/backdoor.js (backdoors) + lib/finish-bn.js (destroying w0r1d_d43m0n),
  // both run off-home. Split because the finisher's single 32GB call used to keep
  // the backdoor loop from ever being placed - see those files' headers.
  backdoor: {
    tickMs: 10_000,
    // gordBackdoorState older than this is from a helper that's gone (or from
    // the previous BitNode - globalThis survives both); never act on it.
    stateStaleMs: 60_000,
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
    // Ascend when the ascension would multiply the member's stats by at least the
    // threshold for the multiplier it ALREADY has: [multiplier below which,
    // threshold]. A big jump for the first ascensions, less and less after - the
    // widely used community table. (The flat x1.5 this replaces was unreachable
    // for a member past ~x4, which then never ascended again.) One member per
    // update at most, so the roster never drops to the gym all at once.
    ascendThresholds: [
      [1.632, 1.6326], [2.336, 1.4315], [2.999, 1.284], [3.363, 1.2125],
      [4.253, 1.1698], [4.860, 1.1428], [5.455, 1.1225], [5.977, 1.0957],
      [6.496, 1.0869], [7.008, 1.0789], [7.519, 1.073], [8.025, 1.0673],
      [8.513, 1.0631], [Infinity, 1.0591],
    ],
    // ...but not while still recruiting, if it would forfeit this much of the
    // respect pool the next recruit needs.
    ascendRespectFraction: 0.4,
    // Train fresh/just-ascended members to this average stat before earning.
    trainMinStat: 60,
    // Once the roster is full, the members with the lowest ascension multiplier
    // keep TRAINING (and ascending) until they reach trainUntilAscMult - working
    // tasks pay a fraction of training's exp, so a member that only works barely
    // ascends after its first time. At most maxTrainFraction of the roster at
    // once; the rest earn. (Sized from a single-member simulation, no gear: about
    // 7x the money after 12h and 1.8x after 48h versus work-only. Lower
    // trainUntilAscMult for income sooner, raise it for more later.)
    trainUntilAscMult: 6,
    maxTrainFraction: 0.5,
    // Max fraction of player money per equipment item. Augs persist through
    // ascension, so they're worth paying more for.
    equipFraction: 0.01,
    augFraction: 0.05,
    // ...and all equipment bought in one tick (every member, every item) may
    // total at most this share of spendable cash.
    equipTickFraction: 0.1,
    // Territory warfare hysteresis on minimum clash win chance.
    warfareEngage: 0.60,
    warfareDisengage: 0.50,
    // Members below these contribute negligible power / die in live clashes
    // (death chance per clash is 0.01 / def^0.6, halved on a win, and only for
    // members on Territory Warfare at the tick - which is now the whole roster,
    // so the defense bar is higher than when half of it stood guard).
    warfareMinStat: 200,
    warfareMinDef: 400,
    territoryDone: 0.999,
    // Territory power is credited only at the 20s territory tick, from members on
    // Territory Warfare at that instant - so lib/gang.js follows the tick and
    // sends EVERYONE there for the one update that contains it. These two only
    // apply while it isn't in step with the tick yet: the old standing crew, half
    // the roster until we out-power rivals by rivalPowerMult, then a token few.
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
    // A sleeve loses ALL its exp when an aug is installed on it, so augs are
    // bought in batches of at least this many per sleeve (or everything it has
    // left on offer), not one at a time as each becomes affordable.
    augBatchMin: 4,

    // Shock at or below this counts as "recovered" -> stop recovery, start sync.
    // ZERO on purpose: the game refuses to sell a sleeve an augmentation while its
    // shock is above 0, so stopping recovery at 1 (the old value) left every sleeve
    // permanently un-augmentable. Full recovery also removes the exp penalty
    // outright. It is NOT quick, though: active recovery sheds a point every ~11
    // minutes, so 100 -> 0 (where every sleeve starts each BitNode) is ~18.5 hours.
    // Hence the two mode-specific gates below.
    shockRecoveredBelow: 0,
    // Gang bootstrap (karma): shock only scales the sleeve's EXP by (100-shock)%,
    // not the karma a crime pays, so the roster starts gymming and criming at this
    // level instead of after the full recovery - the gang arrives in roughly half
    // the time. Shock keeps falling passively while they work, and they finish
    // the recovery (for augs) once the gang exists.
    gangShockBelow: 85,
    // Synchronize until sync reaches this, then switch to productive work. Sync
    // scales how much of a sleeve's exp/earnings flow back to the player, so it's
    // worth maxing before earning in earnest.
    syncTarget: 100,

    // ── Productive work once a sleeve is shock-clear and synced ──────────────
    // Crimes considered each tick; the best EXPECTED $/ms wins (lib/crime-logic.js
    // does the math off ns.formulas.work chances + gains). Order is only a
    // tiebreaker between equal rates.
    crimeCandidates: ["Homicide", "Mug"],
    // Per-attempt durations (ms) and karma per SUCCESSFUL attempt: the shared
    // CRIMES constants above (there's no formulas call that returns either, and
    // ns.formulas.work.crimeGains has no karma field). Karma is used only by the
    // gang-bootstrap ranking, where homicide's 12x per-attempt edge is what pulls
    // it ahead of mug.
    crimeTimeMs: CRIMES.timeMs,
    crimeKarma: CRIMES.karma,
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
    crimeFallbackMoney: CRIMES.money,

    // The faction that sells sleeves + memory. Purchases go through the sleeve API
    // (gated on BitNode 10, not on membership), but joining The Covenant is on the
    // normal aug path anyway, so the daemon keeps pursuing it.
    covenantFaction: "The Covenant",

    // ── Bladeburner nodes (wherever bladeburner.enabled - BN6/BN7) ───────────
    // Once the player is in the division, a shock-clear synced sleeve works for
    // Bladeburner instead of mirroring the player (lib/bladeburner-logic.js
    // planSleeveBladeWork): "Take on contracts" - the sleeve's own stats, the
    // PLAYER's rank, one sleeve per contract name - when it clears the chance bar,
    // else "Infiltrate Synthoids", which adds sqrt(n)/2 attempts per minute to
    // every contract and operation. Attempts are the time gate of these nodes, so
    // even a fresh sleeve is worth more infiltrating than criming. The gang
    // bootstrap (karma) still comes first where a gang is possible: a couple of
    // hours of homicide buys an income that lasts the whole node.
    blade: {
      enabled: true,
      // Nothing a sleeve does for the division depends on its shock or sync:
      // infiltration is a cycle counter, and the chamber / Diplomacy / support act
      // on the player's division. So Bladeburner mode starts at once (100 = never
      // wait); shock still decays passively, and sleeve augs follow when it hits 0.
      workShockBelow: 100,
      // A failed contract costs rank (and the sleeve HP), same bar as the player's.
      minContractChance: 0.8,
      // The game allows one sleeve per contract name, and there are three.
      maxContractSleeves: 3,
      // Stamina is the division's, so a sleeve in the Hyperbolic Regeneration
      // Chamber restores 1% of the PLAYER's max stamina every 60s. When the
      // player's stamina falls below regenBelow, every sleeve not on a contract
      // goes to the chamber until it is back above regenAbove - which keeps the
      // player out of rest phases (they start at bladeburner.restBelow) instead
      // of merely shortening them. Infiltration resumes in between.
      regenBelow: 0.75,
      regenAbove: 0.95,
      // City chaos past bladeburner.chaosDiplomacy penalises every action; the
      // free sleeves run Diplomacy alongside the player until it's back under.
      diplomacy: true,
      // "Support main sleeve" for the black op at hand: each supporting sleeve
      // counts into the team ((team + 1)^0.05 success, ~+10% for six) and, unlike
      // a recruit, can't be lost. The whole roster joins when that bonus would
      // carry a rank-ready black op over bladeburner.blackOpMinChance, and stays
      // until it's done (lib/bladeburner-logic.js nextSleeveSupportState). If the
      // bar still isn't met supportGraceMs after joining (lib/blade-upkeep.js sets
      // the op's team size every upkeep tick), they stand down for supportCooldownMs.
      supportBlackOps: true,
      supportGraceMs: 45_000,
      supportCooldownMs: 10 * 60 * 1_000,
      // gordBladeState (lib/bladeburner.js) older than this means no action loop
      // is up to publish attempt counts; sleeves then fall back to the ordinary
      // ladder rather than infiltrating for a division nobody is working.
      stateStaleMs: 60_000,
    },
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

  // lib/go.js - the IPvGO player, run off-home (9.6GB) by every daemon; the
  // decisions are the pure lib/go-logic.js. IPvGO needs no Source-File, and every
  // finished game adds "node power" for the faction played, which multiplies one
  // stat (bitburner-src src/Go/effects/effect.ts, src/Go/Constants.ts):
  //
  //   opponent         bonus                                power  komi  measured wins
  //   Netburners       hacknet production                    1.3    1.5   ~90%
  //   Slum Snakes      crime success rate                    1.2    3.5   ~70%
  //   The Black Hand   hacking money                         0.9    3.5   ~98%
  //   Tetrads          strength/defense/dexterity/agility    0.7    5.5   ~60-65%
  //   Daedalus         faction AND company reputation gain   1.1    5.5   ~85%
  //   Illuminati       hack()/grow()/weaken() speed          0.7    7.5   ~50%
  //
  //   bonus = 1 + ln(p + 1) * (p + 1)^0.3 * 0.002 * power      (p = node power;
  //   x2 with SF14.1, x GoPower which is 4 in BN14 and 1 elsewhere)
  //   e.g. Tetrads: p 1,000 -> +7.7% to all four combat stats, 10,000 -> +20%.
  //
  // A game adds  black's score x (komi + 0.5) / 4 x streak  to p, where streak is
  // 1 + 0.25 per consecutive win (max 3x) and 0.5 on a loss - so harder factions
  // pay more per point, wins compound, and abandoning a game (which resets the
  // streak) is never worth it. NODE POWER IS WIPED BY EVERY AUG INSTALL
  // (Go.prestigeAugmentation), which is why this plays continuously instead of
  // "until the bonus is good enough": it starts from zero again after each reset.
  // What does survive an install is favor: every second win in a row against a
  // faction you are a member of adds 500 reputation-worth of favor, up to 100k
  // (~81 favor) per faction.
  //
  // "Measured wins" are lib/go-logic.js against the game's own faction AIs
  // (src/Go/boardAnalysis/goAI.ts, run headless outside the game) on a 13x13
  // board, 50-200 games each; batches of 50 scatter by +-10 points, so read them
  // as "which factions are safe wins", not to the percent. Not yet measured in
  // the live game - gordGoState's wins/losses will say.
  go: {
    // Master switch - flip false to play the subnet by hand (the helper and a
    // human on the same board just make each other's moves illegal).
    enabled: true,
    // 5, 7, 9 or 13. Thirteen is the right size for this player: komi is a fixed
    // number of points whatever the board, so it is 22% of a 5x5 board and 3% of
    // a 13x13 one; a game's payout is black's SCORE, which scales with the area;
    // and the faction AIs "do not know about larger jump moves, nor about
    // frameworks", which is all a big board is. Measured against Tetrads the win
    // rate is ~45% on 9x9 and ~60-65% on 13x13. An opponent entry may carry its
    // own `boardSize`.
    boardSize: 13,
    // Who to play, as a weighted rotation: the next game goes to whoever has had
    // the fewest games per unit of weight (counted from the game's own stats, so
    // the split restarts with the bonuses after an install). The bonus curve is
    // steeply diminishing in p, which is the case for spreading games over two or
    // three useful factions rather than pouring them all into one.
    //
    // The default is for a hacking node: reputation gain shortens every faction
    // grind there is, The Black Hand multiplies the batcher's income and is the
    // most reliable win on the list (long streaks), and Illuminati's speed bonus
    // helps every batch but costs a coin-flip game (it starts with five stones on
    // the board and 7.5 komi), so it gets the smallest share. BITNODE[6]/[7] put
    // Tetrads first - see there.
    opponents: [
      { name: "Daedalus", weight: 2 },
      { name: "The Black Hand", weight: 2 },
      { name: "Illuminati", weight: 1 },
    ],
    // Pause between turns. makeMove already waits for the faction's reply (the AI
    // takes ~0.5s a move), so this only guarantees the loop always yields.
    moveDelayMs: 100,
    // Back-off after an unexpected error (a human moving on the same board, etc.).
    errorBackoffMs: 5_000,
    // It is the opponent's turn and nothing has happened for this long (only
    // possible when a board was picked up mid-move): deal a new game.
    stuckMs: 60_000,
    // The game refused this many of our moves on one position: pass instead.
    maxRejects: 5,
    // Random tie-breaking between near-equal moves, in points. Without it the
    // same opening is replayed every game.
    jitter: 0.25,
    // How many of the best one-ply moves are checked against the opponent's best
    // reply (lib/go-logic.js LOOKAHEAD). The cost of a turn is linear in this:
    // ~15-35ms at 6 on a 13x13 board. 1 turns the look-ahead off - cheaper, and
    // measurably weaker against Tetrads, who punish every loose stone.
    lookahead: 6,
    // At most one journal line per this long (a game ends every minute or so).
    journalEveryMs: 15 * 60_000,
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
    // An aug install wipes the stock market, so the daemon asks for a sell-off
    // first (globalThis.gordInstallRequested) and holds the reset until the
    // portfolio is empty - but no longer than installLiquidateTimeoutMs, so a
    // dead or stuck trader can't block a reset. The request itself lapses after
    // installRequestTtlMs if the install never happened.
    installLiquidateTimeoutMs: 60_000,
    installRequestTtlMs: 5 * 60 * 1_000,
    // gordStockState older than this means the trader isn't running.
    stateStaleMs: 60_000,
    // The BitNode's FourSigmaMarketDataApiCost: getConstants() reports base
    // prices, the game charges them times this. BITNODE[7] sets 2.
    fourSigmaCostMult: 1,
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
    // Idle work banks reputation toward a DONATION unlock before it crimes
    // (lib/aug-targets.js pickFavorBankFaction says with whom, and when to stop):
    // favor is the one thing idle reputation buys that money can't. Suspended
    // while a gang is still waiting on karma (idle crime earns the player's share).
    idleFavorBanking: true,
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
      // The "favor" reason (lib/daemon-lib.js installReason): install early when
      // the reset ITSELF carries the faction we're grinding past the donation
      // threshold, so the rest of its reputation is bought instead of ground.
      // It resets a run, so every knob here errs towards not firing:
      favorInstall: true,
      // ...something must be queued (an install with an empty queue is refused
      // by the game, and the NeuroFlux dump must not be what creates one),
      favorMinQueued: 1,
      // ...the run must be at least this old (no back-to-back resets),
      favorMinRunMs: 60 * 60 * 1_000,
      // ...at least this much grind must be left for that faction's augs,
      favorMinGrindMs: 2 * 60 * 60 * 1_000,
      // ...and at today's income, buying that reputation must take no more than
      // this share of the time grinding it would. A quarter, not parity: income
      // is at its lowest right after the reset this triggers.
      favorMaxPayFraction: 0.25,
    },
    // Donations (lib/daemon-lib.js buyAugs / dumpNeuroFlux): once a faction's
    // favor reaches ns.getFavorToDonate(), an aug's missing reputation is bought
    // together with the aug rather than ground.
    donate: {
      enabled: true,
      // Padding on the computed donation, so a float's worth of shortfall can't
      // leave the aug one reputation point short after paying for it.
      margin: 0.01,
      // Don't pay for reputation the work slot delivers within this long anyway.
      skipIfGrindUnderMs: 5 * 60 * 1_000,
      // Without Formulas.exe the dollars-per-reputation rate is a guess until one
      // donation has been measured; that first one is capped at this.
      probeAmount: 1e6,
    },
    // A faction's measured reputation rate is trusted for this long after its
    // last snapshot (the daemon only snapshots the current target's faction).
    repRateMaxAgeMs: 2 * 60 * 1_000,
    // Buy order (lib/daemon-lib.js nextAugPurchase): dearest ready aug first, and
    // while one is unaffordable but within this much income of affordable,
    // nothing cheaper is bought - every purchase raises the rest by 1.9x, so the
    // cheap one would cost more than its price. Further out than this it is
    // skipped instead, so a far-off aug can't freeze everything under it.
    saveHorizonMs: 60 * 60 * 1_000,
    // Loop guard on one tick's purchases.
    maxBuysPerTick: 40,
    // How many candidates the dashboard pipeline shows.
    pipelineSize: 10,
    // Sort rank for factions absent from factions.priority (the last tie-break).
    unknownPriorityIndex: 99,
    // Which aug to work toward (lib/aug-value.js, used by lib/aug-targets.js):
    // the one whose reputation unlocks the most VALUE per unit of time, where
    // value is a weighted sum of ln(multiplier) over the aug's stats. It decides
    // where the work slot and the savings go; it does not decide what is bought
    // (everything that is ready still is, dearest first - see saveHorizonMs).
    value: {
      // Off = every aug is worth the same, i.e. "most augs soonest".
      enabled: true,
      // Weight per stat multiplier (the game's own Multipliers keys; a key not
      // listed is worth nothing). These defaults are for a HACKING node - hacking
      // level and the batcher's three levers first, reputation gain next because
      // it shortens every later grind, combat and crime as small change. A
      // BITNODE entry overrides only the keys it disagrees with.
      weights: {
        hacking: 1.0,
        hacking_exp: 0.5,
        hacking_speed: 0.8,
        hacking_money: 0.8,
        hacking_grow: 0.4,
        hacking_chance: 0.3,
        faction_rep: 0.8,
        company_rep: 0.1,
        strength: 0.1, defense: 0.1, dexterity: 0.1, agility: 0.1,
        strength_exp: 0.05, defense_exp: 0.05, dexterity_exp: 0.05, agility_exp: 0.05,
        charisma: 0.05,
        charisma_exp: 0.02,
        crime_money: 0.1,
        crime_success: 0.1,
        work_money: 0.02,
        hacknet_node_money: 0.05,
        hacknet_node_purchase_cost: 0.01,
        hacknet_node_level_cost: 0.01,
        hacknet_node_ram_cost: 0.01,
        hacknet_node_core_cost: 0.01,
        bladeburner_success_chance: 0,
        bladeburner_max_stamina: 0,
        bladeburner_stamina_gain: 0,
        bladeburner_analysis: 0,
      },
      // Flat value for what an aug does beyond its multipliers. For scale: a
      // +10% hacking-level aug is worth ~0.1 under the weights above.
      special: {
        // Ends the node. Large enough to outrank any ordinary grind, small enough
        // that an aug a few minutes away is still picked up first.
        "The Red Pill": 5,
        // $1M and BruteSSH on every reset from then on.
        "CashRoot Starter Kit": 0.15,
        // Work at full rate without holding the focus.
        "Neuroreceptor Management Implant": 0.2,
        // Programs on every reset (it has real multipliers on top).
        "BitRunners Neurolink": 0.1,
        // Only means anything where Bladeburner is the plan - see BITNODE[6]/[7].
        "The Blade's Simulacrum": 0,
      },
      // Every aug is worth at least this: it counts toward the installed-aug
      // gates (Daedalus), and it keeps a stat-less aug rankable.
      base: 0.02,
      // Added to every wait before dividing. The fixed cost of chasing any
      // target at all - without it an aug five minutes away outranks everything
      // however little it does.
      floorMs: 15 * 60_000,
      // The current target's score is boosted by this much, so a rival has to be
      // clearly better - not better by this tick's rate noise - to take the slot.
      stickiness: 0.25,
      // Planning rate (rep/ms) for a faction when no reputation rate has been
      // measured anywhere yet; scaled by favor. Only ever used to ORDER targets -
      // the ETAs shown on the HUD stay measured-or-blank.
      assumedRepPerMs: 0.001,
    },
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
    // A tick whose decision threw is logged every time but journaled only once
    // per this many consecutive failures (20 ticks = 5 minutes).
    decideErrorEveryTicks: 20,
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
      "Tian Di Hui": { hacking: 50 },
      "Slum Snakes": { karma: -9 },
      "Tetrads": { karma: -18 },
      "The Syndicate": { hacking: 200, karma: -90 },
      "Speakers for the Dead": { hacking: 100, karma: -45, kills: 30 },
      "The Dark Army": { hacking: 300, karma: -45, kills: 5 },
    },

    // Factions that never take donations, whatever the favor: the game refuses
    // any faction that offers no work (and the gang's own, which is detected at
    // run time). Their reputation comes from rank / infiltration / Stanek.
    noDonation: ["Bladeburners", "Church of the Machine God", "Shadows of Anarchy"],

    // Factions that need a server backdoor before you can join.
    backdoor: {
      "CyberSec": "CSEC",
      "NiteSec": "avmnite-02h",
      "The Black Hand": "I.I.I.I",
      "BitRunners": "run4theh111z",
    },

    // Megacorporation factions - unlocked by getting a job at the company and
    // grinding its reputation to the invite gate (~400k), NOT by city/backdoor/
    // combat. Handled by lib/company-work.js, which only a daemon that opts in
    // via `pursueCompanyFactions` imports (default off; BN10 on) - so the other
    // daemons don't even carry its Singularity calls. It only surfaces a faction
    // while it still has an unowned aug; the game auto-invites at the gate.
    // Fulcrum Secret Technologies is omitted on purpose: it additionally needs a
    // backdoor on `fulcrumassets`, which our backdoor helper doesn't target, so
    // we'd grind rep that never converts.
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
    // It doesn't: ns.singularity.workForCompany and applyToCompany have no city
    // check (bitburner-src Singularity.ts, v3.0), so this stays false everywhere.
    // BN9/BN10 used to turn it on "for safety", which only cost $200k trips and
    // parked the player away from Sector-12's gym and university. The switch is
    // kept for a build that does city-lock it: true routes us to (and keeps us in)
    // the company's city while grinding its rep.
    companyWorkNeedsCity: false,
    // The megacorp invite gate (CONSTANTS.CorpFactionRepRequirement). Only the
    // FALLBACK: lib/company-work.js reads the live gate from
    // getFactionInviteRequirements, which is 0.75x this once the company's
    // server is backdoored.
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
    // NOTE: there is deliberately no productCity here any more. Products are
    // designed in the city the product division was FOUNDED in - the free office
    // expandIndustry drops into Sector-12 - resolved live by corp-lib's
    // designCity. Naming a city here was an outright bug: makeProduct throws for a
    // city the division doesn't occupy, so until Tobacco could afford a $9b
    // office+warehouse in the named city it developed nothing, silently, while
    // rounds 3-4 waited on the finished product it was never going to get. The
    // cities are mechanically identical, so the config bought nothing either.

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
    // Buy ORDER per round, where it differs from optionalUnlocks. Round 2 opens
    // with Export (the manual: "buy it at the start of round 2"): it is what
    // makes the Chemical quality loop possible, where Smart Supply is a
    // convenience lib/corp-market.js already covers by hand. Listed second, a
    // modest round 1 bought the $25b convenience and couldn't reach the $20b
    // necessity.
    optionalUnlockOrder: { 2: ["Export", "Smart Supply"] },
    // From this round on, lib/corp-expand.js buys the optional unlocks BEFORE its
    // warehouse-level climb rather than after. The climb spends down to the
    // reserve in a single pass, so second place means never - and Smart Supply is
    // exactly the unlock that stops manual per-second input orders from
    // overshooting into a warehouse and stalling the division. Round 1 keeps the
    // old order: there, warehouse levels genuinely matter more than either
    // unlock, and $25b is most of a self-funded founding stake.
    unlocksBeforeWarehousesRound: 2,
    // Through this round, Agriculture's warehouse-level climb must leave the
    // money its OFFICES still need (seats + Advert to the round target, published
    // by lib/corp-office.js as gordCorpOfficeNeed) untouched. corp-expand runs
    // before corp-office and climbs to the reserve in one pass, so on anything
    // less than a full round the 17-level round-2 climb ate the lot and office 8 /
    // Advert 8 - cheaper, and first in the manual's round-2 order - never landed.
    // Not past round 2: from round 3 the support divisions get a small budget
    // and the product division is the priority.
    officeBeforeWarehouseRound: 2,
    // ...but only while corp-office keeps that figure fresh. Past this age the
    // floor is ignored: a phase that has stopped being placed must not be able
    // to freeze the one that is still running.
    officeNeedStaleMs: 600_000,
    // Advert's price multiplier per level (a game constant - getHireAdVertCost
    // only quotes the NEXT level, and the figure above needs the sum to target).
    advertCostMult: 1.06,

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
      Water: 0.05, Ore: 0.01, Minerals: 0.04, Food: 0.03, Plants: 0.05,
      Metal: 0.1, Chemicals: 0.05, Drugs: 0.02,
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
    // A warehouse this full is CONGESTED: production needs free space for its
    // output, so at ~100% used the division stops producing, which stops it
    // consuming its inputs, which means the stock that filled the warehouse never
    // drains - a permanent deadlock at $0 revenue (manual 12.2). Past this mark
    // lib/corp-market.js drains INPUT overshoot too, not just boost overshoot, to
    // force headroom back open. Only reachable when an order outran its review
    // window (bonus time), which is exactly when it isn't self-correcting.
    warehouseCongestionFraction: 0.95,
    // Rounds at or below this stock boost materials only AFTER the round's
    // capacity is built (gordCorpExpandDone) - the manual's actual order: build
    // the warehouses and offices, THEN spend down into debt on boosts at the end
    // of the round. Buying them first is what left a round-1 corp $1b in debt
    // with its warehouses still at level 1 and no way to pay for the next one.
    boostAfterBuildoutRound: 2,
    // PAST that round, the share of the corp's surplus (funds above the reserve
    // and the banked objective) that one lib/corp-market.js pass may commit to
    // boost-material orders, across all divisions. Until this existed the order
    // was sized by the warehouse shortfall alone, so any positive balance bought
    // the whole pile on credit. A quarter, not all of it: an order is a RATE that
    // runs until the next review, so a rotation running late overbuys in
    // proportion - at 0.25 it can be 4x late before it outruns the surplus.
    boostBudgetFraction: 0.25,
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
    // The SUPPORT divisions' list (Agriculture, Chemical): the same order with
    // the Market-TA pair and the product-only uPgrade: Fulcrum removed. The order
    // is strict, and the TA bundle needs a 140k RP pool a material division never
    // banks - so on the shared list they bought the lab and then nothing, for a
    // research (auto-pricing) that barely matters to a division selling at MP.
    researchPrioritySupport: [
      "Hi-Tech R&D Laboratory",
      "Overclock",
      "Sti.mu",
      "Automatic Drug Administration",
      "Go-Juice",
      "CPH4 Injections",
      "Drones",
      "Drones - Assembly",
      "Drones - Transport",
      "Self-Correcting Assemblers",
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
    // Below this a product isn't worth developing yet - OURS, not the manual's,
    // which sets no minimum at all. It exists so a rich corp doesn't burn a slot
    // on a rubbish product when waiting a cycle would do better, and corp-steady
    // deliberately ignores it for a division's FIRST product: that one is a round
    // gate (productsBeforeRound), not a quality decision, and a corp too poor to
    // clear the floor can only get richer by accepting the round the missing
    // product is blocking.
    productInvestMin: 1e9,
    // Used when getDivision().maxProducts is unavailable.
    maxProductsFallback: 3,
    // Product pricing before Market-TA.II (lib/corp-steady.js nextProductPrice):
    // the price is re-derived every cycle from the last SALE's own numbers, so
    // none of these is a price - they shape how it searches.
    productPricing: {
      // Aim to sell all but this share of the shelf. The leftover is what makes
      // each sale a MEASUREMENT (a sold-out shelf only says "too cheap", not by
      // how much); 2% of one cycle's stock costs ~1% of the markup.
      leftoverTarget: 0.02,
      // Sold out: multiply the markup by this, squaring the step each
      // consecutive sell-out up to the cap. 1.1 keeps a routine nudge (one
      // Advert level) cheap - overshooting by 10% only leaves ~17% of a cycle
      // unsold - while the squaring still climbs six orders of magnitude from
      // MP in under ten cycles.
      probeStep: 1.1,
      probeStepMax: 100,
      // First markup tried from a bare "MP", as a multiple of MP (price = 2x MP).
      seedMarkup: 1,
      // Shelf counts as sold out at or below this share of what was on it.
      soldOutFraction: 0.001,
      // A markup under this share of MP is dropped back to plain "MP".
      minMarkup: 0.01,
    },

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
    // Once a round is ready, hold instead of accepting on the spot: the offer
    // prices the MEAN of the last 10 valuation cycles, so it keeps rising for
    // about a minute after the buildout starts earning. Accept once it has grown
    // less than offerPlateauGrowth between two passes of lib/corp-invest.js (one
    // per rotation, ~60s), but wait at least offerHoldMinPasses and never more
    // than offerHoldMaxPasses. While holding, lib/corp-steady.js stops buying
    // Wilson/Advert/upgrades (globalThis.gordCorpOfferHold): spending funds
    // lowers the valuation being sold.
    offerHoldMinPasses: 2,
    offerHoldMaxPasses: 10,
    offerPlateauGrowth: 0.01,
    // The build phases honour the same hold (corp-expand buys nothing,
    // corp-office grows nothing, corp-market pauses round-3+ boost orders).
    // The hold flag is only honoured while lib/corp-invest.js keeps re-stamping
    // it (gordCorpOfferHoldAt, once per rotation). corp-invest is a one-shot on
    // borrowed RAM and the ONLY thing that can lower the flag, so without an
    // expiry a rotation that stops placing it would freeze every purchase in the
    // corp. Ten minutes is several missed rotations, never one slow tick.
    offerHoldStaleMs: 600_000,
    // Journal a warning when a build phase has gone this many consecutive
    // rotation slots (~a minute each) without finding RAM to run in. The phases
    // are optional one-shots on borrowed off-home RAM, so a network the botnet
    // has filled starves them silently - and a corp whose phases don't run looks
    // exactly like a corp that is patiently saving.
    phaseMissWarnRotations: 3,
    // How long a corp has to be TERMINALLY stuck - profit negative, next buildout
    // step unaffordable - before the rescue sells the round. The dwell is what
    // separates "frozen forever" from the manual's intended end-of-round dip into
    // boost-material debt, which production pays back within a cycle or two. Long
    // enough that no healthy round-1 buildout ever trips it (~5 build-phase
    // rotations), short enough that a genuinely dead corp doesn't sit for hours.
    stallRescueGraceMs: 300_000,
    // Take the corp public once past the investment rounds, issuing 0 new shares
    // (guide FAQ: issue 0). issueDividends is a no-op on a private corp, so this
    // is what actually starts paying the player.
    goPublic: true,
    sharesToIssue: 0,
    dividendRate: 0.1,
    dividendMinProfitPerSec: 1e9,

    // ── Saving horizons (in CORP seconds; bonus time runs cycles ~10x faster in
    // real time, so both are wall-clock pessimistic by roughly that much) ───────
    // How near a division founding has to be before lib/corp-expand.js freezes
    // discretionary spending to bank for it. Past this, the money goes into
    // capacity instead - which raises profit, which brings the founding inside
    // the horizon, at which point the floor engages and banks it. Without a
    // horizon the floor is unconditional, and the BN10 corp showed what that
    // costs: $452m of funds and +$7.4k/s against a $90b floor is 140 days of
    // frozen buildout, with no mechanism that could ever shorten it.
    savingHorizonSeconds: 7200,
    // How far the next buildout step has to be before lib/corp-invest.js calls
    // the corp STALLED and sells the standing round. Deliberately longer than
    // savingHorizonSeconds: try growing out of it first, sell the round only when
    // growth isn't happening either. The same BN10 corp was 26 hours from its next
    // $1.145b warehouse level while turning a profit - technically progressing,
    // actually frozen, and invisible to a plain "is it losing money" test.
    stallHorizonSeconds: 14400,

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
    // The header shows DAEMON DOWN once gordState is older than this (four
    // daemon ticks): its cards would otherwise keep showing a dead daemon's
    // last state as if it were live.
    daemonStaleMs: 60_000,
    // How old a helper's published state may be before its card treats the
    // helper as not running (ui/dashboard-lib.js fresh). Several of its own
    // ticks each: contracts polls once a minute, the trader sleeps 30s without
    // TIX access, and a graft-in-progress publishes slowly.
    staleMs: { helper: 60_000, stocks: 120_000, contracts: 180_000, graft: 120_000 },
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

// What an augmentation is worth on a Bladeburner node (BN6 and BN7 share it):
// the four combat stats ARE the success chance of every contract, operation and
// black op, and (agility) max stamina; the Bladeburner multipliers act on the
// same things directly. Hacking is a side income here, and hacknet nodes are
// switched off. Overlays augs.value key by key.
const BLADE_AUG_VALUE = {
  weights: {
    strength: 1.0, defense: 1.0, dexterity: 1.0, agility: 1.0,
    strength_exp: 0.4, defense_exp: 0.4, dexterity_exp: 0.4, agility_exp: 0.4,
    bladeburner_success_chance: 3.0,
    bladeburner_max_stamina: 1.0,
    bladeburner_stamina_gain: 0.8,
    bladeburner_analysis: 0.3,
    hacking: 0.3,
    hacking_exp: 0.15,
    hacking_speed: 0.2,
    hacking_money: 0.2,
    hacking_grow: 0.1,
    hacking_chance: 0.1,
    // Bladeburners faction rep is rank x this, and it shortens the rest phases' grinds.
    faction_rep: 0.5,
    hacknet_node_money: 0,
    hacknet_node_purchase_cost: 0,
    hacknet_node_level_cost: 0,
    hacknet_node_ram_cost: 0,
    hacknet_node_core_cost: 0,
  },
  special: {
    // Frees the work slot for good: Bladeburner and faction work at once.
    "The Blade's Simulacrum": 3,
    // The node ends on the last black op, not on w0r1d_d43m0n.
    "The Red Pill": 0,
  },
};

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
    // The gang is founded on crime and combat stats, so they count for more here.
    augs: {
      value: {
        weights: {
          strength: 0.3, defense: 0.3, dexterity: 0.3, agility: 0.3,
          crime_money: 0.4,
          crime_success: 0.4,
        },
      },
    },
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

  6: {
    name: "Bladeburners",
    paths: { daemon: "/bn6/daemon.js" },
    // The cold boot gyms to the join gate and joins (early/blade-boot.js).
    bladeburner: { enabled: true },
    // What an aug is worth here - see BITNODE[7].
    augs: { value: BLADE_AUG_VALUE },
    // IPvGO for combat stats first - see BITNODE[7].
    go: {
      opponents: [
        { name: "Tetrads", weight: 3 },
        { name: "Daedalus", weight: 1 },
      ],
    },
    // Hacknet nodes earn a fifth of normal here - see BITNODE[7].
    econ: { hacknetNodes: false },
    // BN6 cuts hacking hard (HackingLevelMultiplier 0.35 plus reduced hack exp and
    // server money) and doubles the world daemon's hacking requirement, so the
    // hacking route to the finish is a very long one. What it gives instead is the
    // Bladeburner division: contracts pay money, rank pays Bladeburners faction
    // reputation and skill points, and the last black op (Operation Daedalus) ends
    // the node without touching w0r1d_d43m0n. So the player's work slot belongs to
    // lib/bladeburner.js by default - see bn6/daemon.js for when it's lent out.
    //
    // Nothing else needs overriding: rank and skills survive an aug install (only
    // entering a new BitNode resets the division), so the default install policy
    // is fine - an install costs stats the Bladeburner Training action rebuilds.
  },

  7: {
    name: "Bladeburners 2079",
    paths: { daemon: "/bn7/daemon.js" },
    // BN6's multiplier table with Bladeburner's own penalties on top (bitburner-src
    // src/BitNode/BitNode.tsx, verified 2026-09-15): the same HackingLevel 0.35,
    // ServerMaxMoney 0.2, HackExpGain 0.25, GangSoftcap 0.7, WorldDaemonDifficulty
    // 2 and BladeburnerRank 0.6 - plus ScriptHackMoney 0.5 (BN6: 0.75),
    // AugmentationMoneyCost 3 (every aug costs triple), BladeburnerSkillCost 2
    // (every skill level costs double) and 4S data/API at 2x. Its Source-File
    // buffs the four bladeburner_* multipliers (+8/12/14% at 7.1/7.2/7.3) and
    // 7.3 hands out The Blade's Simulacrum the moment you join the division.
    //
    // Same shape as BN6, so the same daemon core (lib/blade-daemon.js) and the
    // same cold boot (early/blade-boot.js). What changes is the tuning:
    bladeburner: {
      enabled: true,
      // Three runs by default: 7.1 -> 7.2 -> 7.3 (the free Simulacrum). The HUD's
      // FINISH toggle holds Daedalus regardless; `run bn7/daemon.js <n>` overrides.
      reenterUntilSF: 3,
      // Skill points buy half as much here, so they concentrate on the levers that
      // pay on EVERY action - success chance and action time - and the stat
      // multipliers behind them. Estimate width (Datamancer) is Field Analysis's
      // job during rest phases, and Tracer only helps contracts. Contract money is
      // a real income where hacking pays half of BN6's half and augs cost triple,
      // so Hands of Midas keeps a real weight rather than BN6's token one.
      skills: {
        "Blade's Intuition": { weight: 3 },
        "Overclock":         { weight: 3 },
        "Digital Observer":  { weight: 2 },
        "Short-Circuit":     { weight: 2 },
        "Reaper":            { weight: 2 },
        "Evasive System":    { weight: 2 },
        "Cloak":             { weight: 1.5 },
        "Hands of Midas":    { weight: 1 },
        "Cyber's Edge":      { weight: 1 },
        "Hyperdrive":        { weight: 0.5 },
        "Tracer":            { weight: 0.5, cap: 10 },
        "Datamancer":        { weight: 0 },
      },
    },
    // Augs cost triple, so every install is a bigger bet: batch them like BN9 does
    // rather than resetting on the default handful. Rank and skills survive the
    // install either way.
    augs: {
      install: {
        queuedThreshold: 8,
        priorityQueuedThreshold: 4,
        // Without this the batching above never happens: once the five cheap
        // installPriority augs are installed, the "aggressive" path installs on
        // minQueued - by default ONE aug.
        minQueued: 4,
        // The "favor" reason may cut the batch short - unlocking donations is
        // worth more here, with rep bought instead of ground at triple-price augs
        // - but not for a single aug.
        favorMinQueued: 2,
      },
      value: BLADE_AUG_VALUE,
    },
    // IPvGO (lib/go.js): on a Bladeburner node the bonus worth having is Tetrads'
    // - a multiplier on all four combat stat LEVELS, which are most of the weight
    // in every contract, operation and black op's success chance, and (agility)
    // max stamina and stamina regen. Hacking money and hack speed, the default
    // rotation's picks, are worth little where ScriptHackMoney is 0.5 on a
    // ServerMaxMoney of 0.2. Daedalus keeps a share: Bladeburners faction rep is
    // 2 x rank x the faction-rep multiplier, and it shortens every other grind.
    go: {
      opponents: [
        { name: "Tetrads", weight: 3 },
        { name: "Daedalus", weight: 1 },
      ],
    },
    // 4S market data and its API cost double here (FourSigmaMarketDataApiCost 2).
    stocks: { fourSigmaCostMult: 2 },
    // lib/econ.js's hacknet-NODE buyer has no payback test, and here nodes earn a
    // fifth of normal (HacknetNodeMoney 0.2) and are wiped by every install: a
    // maxed node is ~$400m for ~$1.8k/s. Off.
    econ: { hacknetNodes: false },
  },

  9: {
    name: "Hacktocracy",
    paths: { daemon: "/bn9/daemon.js" },
    // BN9 guts every normal engine - ScriptHackMoney 0.1 on top of ServerMaxMoney
    // 0.01 (hacking earns ~0.1% of normal), HackExpGain 0.05, HackingLevel 0.5,
    // combat/charisma 0.45, CrimeMoney 0.5, CloudServerLimit 0 (no purchased
    // servers), HomeComputerRamCost 5x, WorldDaemonDifficulty 2 (w0r1d_d43m0n
    // wants hacking 6000) - and hands you HACKNET SERVERS: hashes sell for money,
    // buy study/gym multipliers, and rebuild a hacking target's money/security.
    // The fleet is therefore the economy, and lib/hacknet.js gets the budget.
    hacknet: {
      enabled: true,
      spendFraction: 0.6,
      reserveMoney: 200_000,
      maxPaybackMs: 6 * 60 * 60 * 1_000,
    },
    // lib/hacknet.js owns hacknet spending here; the node buyer stays out.
    econ: { hacknetNodes: false },
    // IPvGO: Netburners' bonus is hacknet production - the node's whole economy -
    // and it is one of the more reliable wins (~90%). Daedalus for faction rep.
    go: {
      opponents: [
        { name: "Netburners", weight: 3 },
        { name: "Daedalus", weight: 1 },
      ],
    },
    // An aug install wipes the hacknet fleet AND every hash upgrade (and hacking
    // exp, as always) - each reset restarts the node's engine from scratch. So
    // installs are batched bigger and less often than the default policy.
    augs: {
      install: {
        queuedThreshold: 8,
        priorityQueuedThreshold: 4,
        // The "aggressive" and time-trigger floor - see BITNODE[7].
        minQueued: 4,
        timeTriggerMs: 16 * 60 * 60 * 1_000,
        // The "favor" reason, tightened: a reset here costs the fleet and every
        // hash upgrade, and cash (what a donation is paid in) is the scarce thing.
        // So more queued, a longer grind to be saved, and income must buy that
        // reputation ten times faster than work earns it, not four.
        favorMinQueued: 2,
        favorMinGrindMs: 6 * 60 * 60 * 1_000,
        favorMaxPayFraction: 0.1,
      },
      // The fleet is the economy, so hacknet multipliers lead; hacking level and
      // exp still matter (the world daemon wants 6000), hacking MONEY does not
      // (it earns ~0.1% of normal here).
      value: {
        weights: {
          hacknet_node_money: 2.0,
          hacknet_node_purchase_cost: 0.4,
          hacknet_node_level_cost: 0.4,
          hacknet_node_ram_cost: 0.4,
          hacknet_node_core_cost: 0.4,
          hacking_exp: 0.8,
          hacking_money: 0.05,
          hacking_grow: 0.05,
          hacking_speed: 0.3,
        },
      },
    },
    // The final stretch is a long no-reset run (study to the world daemon's
    // hacking gate, grafting for multipliers), so like BN10 the megacorp factions
    // are worth grinding once the ordinary ones run dry.
    factions: { pursueCompanyFactions: true },
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
    // No CONFIG overrides for the economy, though BN10 is NOT a BN4 clone
    // (bitburner-src BitNode.tsx): AugmentationMoneyCost 5 and AugmentationRepCost
    // 2, HackingLevelMultiplier 0.35, combat/charisma 0.4, ScriptHackMoney /
    // CrimeMoney / CompanyWorkMoney 0.5, CloudServerCost 5 with CloudServerLimit
    // 0.6 and CloudServerMaxRam 0.5, WorldDaemonDifficulty 2. The aug pipeline
    // reads prices and reputation requirements live, so it needs no table for
    // any of that - augs are simply five times dearer and twice the grind, which
    // is what makes donations (augs.donate) matter here. What's unique is
    // duplicate sleeves - bought from The Covenant and driven by lib/sleeves.js
    // (launched off-home by bn10/daemon.js).
    // The daemon deliberately does NOT auto-destroy w0r1d_d43m0n (plannedNextBN
    // returns the halt sentinel): the whole point of BN10 is to stay and buy
    // EVERY sleeve + max memory on your first pass, since the sleeve shop only
    // exists here. Finish manually once the sleeve roster is complete.
    //
    // Once the joined-faction augs run dry, grind megacorp reputation to unlock the
    // corporation factions and their augs (pursueCompanyFactions).
    factions: { pursueCompanyFactions: true },

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
