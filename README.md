Bitburner scripts for my playthrough. 

## Configuration

Every tunable value lives in [`lib/config.js`](lib/config.js) — thresholds, budgets,
tick intervals, RAM reserves, script paths, host names, and the faction/aug/corp
reference tables. It has no Netscript calls, so it costs 0GB and is safe to import
from anything (including the deliberately-lean `early/driver.js`).

- `CONFIG` — shared defaults. Import this from any BN-agnostic library.
- `BITNODE` — per-BitNode override struct, keyed by node number. Only holds keys
  that genuinely differ (e.g. the gang karma gate: `-9` in BN2, `-54000` elsewhere).
- `forNode(n)` — `CONFIG` deep-merged with `BITNODE[n]`. Each `bnX/daemon.js` calls
  `forNode(2)` / `(3)` / `(4)` at module scope, since it knows its node literally.

Two things deliberately stay out: `lib/gang.js`'s gain-formula replicas (they
transcribe the game's own `formulas.ts`) and the dashboard's layout CSS.

## Formulas API

[`lib/formulas.js`](lib/formulas.js) wraps Bitburner's Formulas API with a runtime
safeguard. `ns.formulas` throws unless `Formulas.exe` is on home. SF-5 ("start with
Formulas.exe") and BN-5 itself both grant the exe, so with SF-5 we normally have it
from the start of every node — but it's still a file: it's briefly absent at the
very start of BN-5 until a soft reset ([bitburner#2675](https://github.com/danielyxie/bitburner/issues/2675)),
and any node entered without adequate SF-5 lacks it. `hasFormulas(ns)` detects the
exe at runtime, so callers use exact formula math when it's present and fall back
to the approximate `ns.*` analysis functions when it isn't — a no-op in the normal
case, insurance otherwise. The `ns.formulas.*` calls themselves cost 0GB.

Today the HGW botnet ([`hacking/manager.js`](hacking/manager.js)) uses it to size
batches and score targets at the **prepped** (min-security, max-money) state a
batch actually farms — exact steal-%, exact grow threads, and min-security batch
timings — instead of the target's current-security state. `lib/gang.js`'s replicas
and `lib/econ.js`'s hacknet buys remain candidates for the same treatment.

## HGW batcher

[`hacking/manager.js`](hacking/manager.js) is the Netscript I/O shell; every
sizing and scheduling decision is the pure, unit-tested
[`lib/batch-logic.js`](lib/batch-logic.js). It is a **continuous scheduler**, not
a "launch the largest batch that fits, every tick" loop:

- The four legs land `H, W1, G, W2` around the weaken time (`legSchedule`), and
  launches are spaced by that landing span plus `hacking.launchMarginMs`. That
  guarantees batch N+1's first landing follows batch N's last — the whole
  correctness condition, since each batch restores the prepped state before the
  next one's hack lands. (The old loop launched every 200 ms, so every hack after
  the first landed on an already-hacked server, and the first landing hack
  tripped a re-prep that blocked launching for a grow-time.)
- Timing then fixes how many batches are in flight (`batchDepth`, capped by
  `hacking.maxDepth`), and the money fraction per batch is the largest in
  `hacking.moneyFractions` that lets that many batches share the target's RAM
  budget (`planCycle`). A batch is allocated across hosts as a whole and launched
  entirely or not at all (`allocate`).
- Targets are ranked by the **income each would earn with the whole botnet behind
  it** (`incomeRate`, $/ms). Two earlier metrics were wrong here:
  `maxMoney / minSec / hackTime` ignored what a batch costs, and $ per GB-second
  (its replacement) ranked by RAM *efficiency* — and the most efficient target is
  the cheapest, not the richest.
- **One target cannot absorb a big botnet.** Its launch interval is fixed by
  timing, so it pays at most `maxHackFraction` of its money every ~1.2s however
  much RAM exists — which at a low hacking level, where n00dles is the best server
  in reach, is a few hundred GB against a multi-TB fleet. So the manager services
  the top `hacking.maxTargets` targets in rank order, each planned against the RAM
  the ones above it don't claim (down to `hacking.minTargetRam`). Same scheduler
  per target, own launch clock, own prep and drift state; the primary still takes
  the fattest bite it can, and only what it can't absorb spills down.
- Prep is one joint weaken+grow pass sized so the weaken also covers the grow's
  own security (`prepPlan`), and it does **not** block the loop: the manager keeps
  ticking (share, the other targets) and simply doesn't launch against that target
  until its legs land. A target that can't plan a cycle at all (mid-prep, or a
  botnet too small) claims its whole budget, so a prep is never starved by the
  targets below it.
- While batches fly, the target is checked against the worst case one open batch
  can explain (`driftDetected`); real drift stops launching, the window drains in
  a weaken-time, and the target is re-prepped.
- One network snapshot per tick; rooting, script copies and target re-ranking are
  throttled (`networkRescanMs`, `rootRetryMs`, `targetRescoreMs`).
- The loop body is exported as `step(ns, state, now)`, so
  [`tests/batcher-sim.test.mjs`](tests/batcher-sim.test.mjs) drives the whole
  scheduler under Node against a fake `ns` (a model network whose money, security
  and leg durations respond to landings) and asserts the promises above: every
  hack lands on a prepped server, launches are continuous and never exceed the
  depth, the drift detector is quiet in a clean run and fires/recovers on an
  outside hit, prep converges monotonically (one or two passes with ample RAM),
  and — the reason the spill exists — a 16TB botnet whose only reachable targets
  are n00dles-alikes earns several times more, on several times the RAM, than the
  same world limited to one target.

After syncing a change to the manager, run `run /tools/kill-helpers.js all` before
restarting: the manager runs off-home, so `killall` on home leaves the old copy
running and the daemon never launches the new one.

When the botnet looks dead or idle, [`tools/hack-status.js`](tools/hack-status.js)
says which of the two it is in one shot: whether the daemon and the manager are
running (and where), whether anything has room to *start* the manager — right after
it dies its own worker legs still hold the fleet, so for about a weaken-time there
is genuinely nowhere to put it — what the running legs are hacking, and the target
table it would rank, with the RAM each target would hold.

```text
run tools/hack-status.js
```

## BitNode entry points

Each bitnode gets a thin `bnX/daemon.js` orchestrator; everything reusable lives in `lib/`.

- `bn4/daemon.js` — BN4 (Singularity): faction/aug pipeline, backdoors, install loop.
  The reference implementation — the other four are this plus one special system.
- `bn2/daemon.js` — BN2 (gangs): bootstraps Slum Snakes (30 combat stats, -9 karma, $1M),
  creates the gang, then launches `lib/gang.js` on whatever server has ~35GB free.
- `lib/gang.js` — standalone BN-agnostic gang manager (recruit/ascend/equip/tasks/territory);
  reusable in any bitnode with SF2 gang access.
- `bn9/daemon.js` — BN9 (Hacktocracy): the hacknet-server fleet is the economy (see
  below); installs are batched bigger, hashes are sold before every reset, and idle
  time studies toward the world daemon's doubled hacking gate.

[`lib/daemon-lib.js`](lib/daemon-lib.js) holds the building blocks that are
identical across all five: rooting, darkweb buys, accepting invites, off-home helper
placement, the gang manager's placement, faction work, `buyAugs`, the install policy,
and the purchased-server budget. [`lib/daemon-core.js`](lib/daemon-core.js) holds
the skeleton built from them: `runDaemon(ns, hooks)` is `main()` (the tick loop and
the helper launch order), and `decidePrelude` / `decideNoTarget` / `decideAugFlow`
are the parts of `decideNextPriority` every node shares (train → rep → money → buy).
A node's daemon is then just its strategy prefix plus hooks: `maybeSetupGang` (BN2's
-9 shortcut vs BN5's active karma grind vs everyone else's passive snap-up),
`plannedNextBN`, extra helpers, the status line. All five daemons are on the core;
`bn10/daemon.js` is the fullest example of the hooks (required sleeve manager,
grafting as an extra helper, a stay-city publish after the decision, its own
no-target branch for the money hoard and grafting).
`lib/aug-targets.js`'s `factionRepStillUseful` is the one predicate behind every
"should the work slot go to this faction?" decision. Megacorp-faction grinding
(`factions.pursueCompanyFactions`, BN10) lives in
[`lib/company-work.js`](lib/company-work.js), which only an opted-in daemon imports
and hands to the core as `hooks.companyWork` — so the other daemons don't carry its
`workForCompany`/`applyToCompany`/`getCompanyRep` calls (7GB) for a branch they never
take. Small shared wrappers (`playerMoney`, `hackingLevel`, `inGangSafe`,
`spendableMoney`, `reservedHosts`, `freeRam`) are in
[`lib/ns-utils.js`](lib/ns-utils.js). Note this is a *maintainability*
win, not a RAM one: Bitburner charges the API calls of every function reached from
`main` either way. RAM savings come from moving work into off-home helpers, which is
why `lib/` is full of them.

## Capabilities

[`lib/capabilities.js`](lib/capabilities.js) centralizes "which gated API is usable
this run" into one **0GB** check (it reads `ns.getResetInfo()`, which is free).
Every Source-File/BitNode-gated API — Singularity, Gang, Corporation, Sleeves,
Grafting, Bladeburner, Hacknet-Server, Stanek — is available when you're in its
BitNode *or* hold its Source-File, so this replaces scattered `try/catch` probes
with `getCapabilities(ns)`. The decision logic is pure (`sourceFileLevel`,
`hasApiAccess`, `singularityRamMultiplier`, `capabilitiesFromReset`) and unit-tested.

## Hacknet servers (BN9)

BN9 cuts hacking income to ~0.1% of normal (`ScriptHackMoney` 0.1 on a
`ServerMaxMoney` of 0.01), hacking exp to 5%, crime money in half, forbids purchased
servers and prices home RAM at 5x — and doubles the world daemon's hacking gate to
6000. What it gives back is hacknet **servers**, whose hashes sell for $1M per 4 and
buy the upgrades that make the node beatable. [`lib/hacknet.js`](lib/hacknet.js) is
the fleet manager, an off-home helper `early/driver.js` starts on the very first
tick there and `bn9/daemon.js` keeps as a *required* helper; every decision is the
pure, unit-tested [`lib/hacknet-logic.js`](lib/hacknet-logic.js):

- **Fleet growth** ranks every purchasable step (new server, +1 level, x2 RAM, +1 core)
  by *marginal hashes per dollar* (`rankUpgrades`, using `ns.formulas.hacknetServers`
  when Formulas.exe is present) and buys the best one that fits the budget **and pays
  for itself** — at the sell-for-money rate — within `hacknet.maxPaybackMs`
  (`pickUpgrade`). That horizon is the only brake: the first servers pay back in
  seconds, a maxed fleet's last cores in days. While the daemon is saving for an aug
  the horizon shrinks to `savingPaybackMs`, so only upgrades that delay the aug by
  less than they speed up everything after it still go through. Cache is bought when
  a wanted hash investment can't fit the capacity we have.
- **Hash spending** (`planHashSpend`) sells everything not earmarked — a full cache is
  production thrown away — and takes the *investments* in priority order when
  affordable: `Improve Studying` / `Improve Gym Training` while the player is doing
  exactly that (hacking level is the node's real gate), `Reduce Minimum Security` /
  `Increase Maximum Money` on the batcher's primary target, a rate-limited
  `Generate Coding Contract` for `lib/contracts.js`. The best unaffordable one is
  saved toward only while it costs at most half the cache. The daemon's
  `gordHashHints` flips it all to *cash priority* (sell every hash) while cash is the
  bottleneck: before TOR, during an invite hoard, and while an aug is paid up in rep
  but not in money.
- **Installs wipe the fleet**, every hash upgrade and (as always) hacking exp, so
  `BITNODE[9]` batches installs bigger and rarer, and the daemon's `beforeInstall` hook
  (new in `lib/daemon-core.js`, honoured by `maybeInstall`) asks the helper to sell
  every hash and holds the reset until it answers (`gordHashDumpRequested` /
  `gordHashDumpDone`, with a timeout so a dead helper can't block a reset).
- **Hacknet servers are rooted RAM** the botnet would otherwise fill, and a script on
  one cuts its hash rate in proportion — so the daemon's `reserveHosts` hook (also new)
  adds them to `gordReservedHosts`. Flip `hacknet.botnetMayUse` to hand them over.
- The HUD gets a **HACKNET** tab ([`ui/bn9.js`](ui/bn9.js)): cache fill, rate as
  cash, what the hashes are becoming, the multiplier levels, and the fleet.

`lib/econ.js`'s cheap hacknet-*node* buyer is switched off there (`econ.hacknetNodes`)
so the two never compete for the same money; it now takes the node number as exec
arg [1] to resolve that.

## Coding contracts

[`lib/contracts.js`](lib/contracts.js) is an off-home helper (launched by every
daemon via `ensureHelper`) that scans the whole network for `.cct` files and solves
them for money/rep/karma — a universal, node-agnostic income source the botnet
ignores. The solver set in [`lib/contract-solvers.js`](lib/contract-solvers.js) is
**pure** (0GB, unit-tested) and covers all 30 current contract types; unknown/future
types are **skipped without spending a limited attempt**, so it can never destroy a
contract by guessing.

## Sleeves

[`lib/sleeves.js`](lib/sleeves.js) is an off-home helper launched by **every** daemon
(it's ~72GB of `ns.sleeve.*` at 4GB a method, so it never shares home, and it's
launched `optional` outside BN10 so it waits quietly until a host has room). It
self-exits where sleeves
are unavailable, so launching it everywhere is inert on nodes that can't use it.

Every sleeve clears **shock** to zero (which is also what unlocks buying it
augmentations — the game refuses while shock > 0), then **synchronizes** to 100, then
earns. What "earns" means depends on the gang:

- **Gang bootstrap** — gang API available, no gang yet. Sleeve crime karma counts for
  the player, so the roster is the fastest route to the karma gate. Crimes are ranked
  by **karma/ms** instead of money, which produces the ladder: gym the weakest combat
  stat → mug at `crimeMinChance` → homicide as soon as it clears the same bar.
- **Mirror** — once we're in a gang (or gangs aren't available here), each sleeve
  shadows the player's own work slot: same crime, same faction (preferring the same
  job type), same company, same gym stat. Anything it can't or shouldn't copy falls
  back to its own money-best crime, then the gym. Studying is deliberately *not*
  mirrored by default (`sleeves.mirrorStudy`): tuition per sleeve, no income, and the
  sleeve's own crime ladder both earns and syncs combat exp back.

**Augmentations** are bought everywhere, cheapest-first across the roster, once cash
clears `sleeves.augMinMoney`. **Buying sleeves and memory** only works in BitNode 10,
where The Covenant sells them, so that shop is its own helper,
[`lib/sleeve-shop.js`](lib/sleeve-shop.js) (~26GB), launched by the daemon core only
in `sleeves.shopBitNode`: its four `ns.sleeve.*` shop calls are 4GB each and would
otherwise be charged to the manager on every node (the manager is ~55GB without
them). The shop publishes `gordSleeveShop`, which the manager folds into
`gordSleeveState`, so the SLEEVE tab is unchanged.

Helpers that only need the current node number take it as an exec arg from the
daemon (`lib/backdoor.js`, `lib/sleeves.js`, `lib/sleeve-shop.js`,
`lib/corp-create.js`): `ns.getResetInfo()` costs 1GB, which the daemon pays once
anyway and a small helper shouldn't pay again for one integer.

In BN10 buying that shop out *is* the node, so `BITNODE[10].sleeves` turns the
budgets up (buy a sleeve at ~1.1x its price rather than waiting for 2x, and push
memory and sleeve augs just as hard). Order of preference is sleeves → augs → memory:
a sleeve is an extra earner for the rest of the run *and* arrives with its own 99
memory levels, while memory only sets starting sync in a *future* BitNode. But memory
defers to the next sleeve only while that sleeve is within `memoryDeferSleeveReach`
of affordable — `getSleeveCost` climbs to ~1e20, and gating memory on a *complete*
roster (the old rule) meant an unaffordable last sleeve blocked it forever, ending
the run with none of the one upgrade that carries forward. The manager announces once
when the shop is bought out, which is the cue to finish the node.

## Corporation

The corp manager follows the community *Corporation manual* (Agriculture + Chemical
+ Tobacco, all four investment rounds, go public, dividends) and is split by RAM
shape: Bitburner prices the corp API per **distinct call** — 10GB per getter, 20GB
per action — so a script's size is set by how many different calls it can reach.
The old single builder reached ~30 (~490GB); it's now:

- [`lib/corp-upkeep.js`](lib/corp-upkeep.js) (**~62GB, always on**) — buys tea and
  throws a party for every office, once per corp cycle, **unconditionally** — it
  keeps working while you manage the corp by hand, and places even when nothing
  else fits. Energy/morale multiply every office output
  (`ProductionBase = AvgMorale × AvgEnergy × 1e-4`), and the party spend is the
  manual's closed-form optimum `x = 5e5·(√((a·k−10)² + 40b) − a·k − 10)` — lands
  exactly on max morale each cycle (unit-tested), instead of a flat 500k guess.
- [`lib/corp-steady.js`](lib/corp-steady.js) (always on, cloud-corp host) —
  products, Wilson + Advert (Wilson isn't retroactive, so it's bought the cycle
  it's affordable), corp-wide upgrades, dividends, dashboard state.
- Four **one-shot build phases**, run in rotation by
  [`lib/corp-daemon.js`](lib/corp-daemon.js), one per daemon tick, so peak
  footprint is one phase (~120–200GB): [`corp-expand`](lib/corp-expand.js)
  (unlocks, cities, warehouses, exports, dummy divisions),
  [`corp-office`](lib/corp-office.js) (sizes, hiring, the zero-then-set job
  protocol), [`corp-market`](lib/corp-market.js) (inputs, boost materials,
  selling, research), [`corp-invest`](lib/corp-invest.js) (rounds, going public —
  and the round publisher). Phases coordinate via `globalThis` handshakes, never
  imports: importing another phase would pull its calls into your RAM closure.

Manual-derived behaviour worth knowing: boost/input materials use **`buyMaterial`
per-second orders, not `bulkPurchase`** — orders may take the corp into debt, which
is the intended end-of-round shape; boost quantities are the manual's **closed-form
Lagrange optimum** (`optimalBoostQuantities` in `lib/corp-lib.js`, unit-tested
against the manual's own tables), not a factor-proportional split; export routes
use the optimal string `(IPROD+IINV/10)*(-1)`; rounds 1–2 hold everyone on **R&D
until the RP gates** (55, then Agri ~700 / Chem ~390), round 2's offer can't be
accepted before them, and corp-wide upgrades are restricted to Smart
Storage/Factories until round 3; research starts **round 4**, capped per purchase
to a fraction of the RP pool (½ lab/TA, ⅕ stat, ⅒ production); **dummy Restaurant
divisions** (6 cities, 6 warehouses, nothing else) multiply the offer ~1.1× each
via the valuation exponent; product design invest is 1% of funds (it scales as
x^0.1), the lowest-rated product is recycled once slots are full, and Advert's
funds share steps up from 20% to 50% past ~1e18/s profit (the manual's
"threshold of focusing on Advert").

## HUD toggles

The GORDNET header carries three switches. Each is a `globalThis` boolean the HUD
assigns and a daemon reads — a click handler can't call `ns` without stopping the
script, so that indirection is the whole mechanism.
[`lib/toggles.js`](lib/toggles.js) adds the durability: each value is mirrored to a
one-word file (`CONFIG.paths.focusFile` / `autoFinishFile` / `autoCorpFile`) and
re-seeded from it, because both an aug install and a page reload wipe `globalThis`,
and a switch you deliberately turned off silently turning itself back on hours later
is exactly what these exist to prevent. All default **on** — the behaviour from
before they existed.

**FOCUS: AUTO / OFF.** Focused work pins the game to its work screen and the daemon
re-issues that work every tick, which makes hand-managing the corporation or the gang
impossible. Off, [`lib/player-actions.js`](lib/player-actions.js) `focusFlag()` stops
passing `focus=true`, and `setFocus(false)` drops focus on the work already running
(a crime in progress is never re-issued, so otherwise the change wouldn't land until
the crime changed). Unfocused work runs at 80% rate unless the Neuroreceptor
Management Implant is installed. It changes *only* the focus flag: `shouldFocus()` —
the "can we background a second job?" question the daemons branch on — is untouched,
so this doesn't rewire which work the bot picks.

**FINISH: AUTO / OFF.** Off, the daemon runs exactly as normal and still backdoors
`w0r1d_d43m0n`, but never destroys it. Enforced in
[`lib/daemon-lib.js`](lib/daemon-lib.js) `ensureBackdoorHelpers`, alongside the
existing per-node halt sentinel (`nextBN <= 0`, e.g. BN10) — either hold announces
itself once and leaves the world daemon standing. Flipping it off *after*
`lib/finish-bn.js` was launched also kills that process, since it loops waiting for
its moment and would otherwise beat the node a few ticks later anyway.

**CORP: AUTO / OFF.** Off, the daemon deploys no corporation script at all — the
creator, the always-on operator and upkeep pair, and the four build phases — and
kills every one of them that's already running, so the corporation is entirely yours
to run by hand. Enforced in [`lib/corp-daemon.js`](lib/corp-daemon.js)
(`corpAutoEnabled` / `stopCorpScripts`), which sweeps the network every tick while
the switch is off: the managers are loops on borrowed off-home RAM, so merely not
re-launching them would leave the running copies hiring and accepting investment
offers under your hands. The `cloud-corp` reservation is dropped too, handing that
host back to the botnet, and the HUD's CORP tab says the switch is off rather than
reporting a dead manager. Everything else the bot does is unaffected; flipping it
back on re-places the managers on the next daemon tick.

## Self-test

Since this project can't run `tsc`, [`tools/self-test.js`](tools/self-test.js) is the
in-game pre-flight check — run it after a sync, before `killall; run /early/driver.js`:

```text
run tools/self-test.js
```

It verifies every `CONFIG.paths` script exists, runs `getScriptRam()` over every
`.js` on home (which parses each file and resolves its whole import closure, so a
`0` result flags a syntax error or a missing/renamed import — a real compile check),
reports each script's RAM cost, checks whether the current node's daemon fits home
(i.e. whether `early/driver.js` will hand off yet), and prints detected API
capabilities plus contract-solver coverage. It makes no purchases and never resets.

## Testing

The pure (`ns`-free) logic modules — `lib/capabilities.js`, `lib/contract-solvers.js`,
`lib/grafting-logic.js`, `lib/crime-logic.js`, `lib/batch-logic.js`, `lib/hacknet-logic.js` — have Node unit tests under
[`tests/`](tests/). With Node ≥20:

```bash
npm test
```

This runs `node --test tests/*.test.mjs`. The game itself needs no build step; Node
is only used to test the pure logic. Everything that touches `ns` stays in the
importing module (e.g. `lib/grafting.js` gathers game data, then delegates the
graft-vs-crime decision to the pure `lib/grafting-logic.js`).

