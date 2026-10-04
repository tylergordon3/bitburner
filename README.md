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
timings. Without Formulas.exe the same prepped-state figures are derived from the
`ns.*` analysis calls by scaling them from the current security to the minimum with
the game's own formulas (`preppedScale`), so both paths plan for the state a batch
lands on. `lib/gang.js`'s replicas
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
- A leg's duration is fixed by the game when the leg **starts**, at the target's
  security at that moment — and with other batches in flight that is often not the
  prepped minimum (a hack or grow has landed, its weaken hasn't). So the workers
  pass their delay to the game as `additionalMsec` (the duration locks at launch,
  not after an in-script sleep), and the manager computes each leg's delay from the
  leg times *as they are at launch* (`landingDelays`), aimed at a **landing window**
  the batch owns. Windows are one launch interval apart; the launch itself opens
  `hacking.launchLeadMs` early so it can wait out the few hundred ms in which
  security is raised without the window slipping. Before this, a fat batch's grow
  stretched any leg started inside it by seconds against a 200 ms spacing, batches
  landed `W1, G, H, W2`, and the target spent ~40% of its time draining.
- Timing then fixes how many batches are in flight (`batchDepth`, capped by
  `hacking.maxDepth`), and each batch is the fattest that lets that many share the
  target's RAM budget — sized **to the hack thread** by a binary search
  (`largestBatch` / `planCycle`), up to `hacking.maxHackFraction` of the target's
  money. When the budget can't carry a full window of *efficient* batches the
  window is **thinned** instead (`efficientThreads`): a one-thread batch still
  needs a grow and two weaken threads, so a 440GB botnet stole three times as much
  from 7 batches of 4% as from 34 batches of 0.4%. (It used to pick from a ladder of fractions 2–2.5x apart: a budget just
  short of a rung fell to the one below, leaving the best target on ~40–65% of the
  RAM it had been handed.) The grow carries `hacking.growPadding` extra threads: a
  batch's grow only repairs its own hack, so an exact count lets any shortfall — the
  hacking level rising while the batch is in flight — stack until the target drifts.
- A batch is allocated across hosts as a whole and launched entirely or not at all
  (`allocate`). Each leg goes onto one host when any has room — the tightest fit —
  because a grow **split** across hosts lands weaker than planned (its parts land
  one after another, each raising security for the next); when a split can't be
  avoided that batch's grow is padded for it (`splitGrowPadding`).
- What a weaken thread removes is asked of the game (`ns.weakenAnalyze`, 1GB), not
  taken as 0.05: the `ServerWeakenRate` BitNode multiplier doubles it in BN11 and
  shrinks it with every level of BN12.
- The botnet's RAM is **split between targets so the last gigabyte earns the same
  on each** (`allocateRam`, over every target's `incomeCurve`). A target's income
  is linear in its bite but its RAM is not — the grow that repairs 50% costs far
  more than five that repair 10% — so income per GB falls as the bite fattens.
  Three earlier rankings were wrong here: `maxMoney / minSec / hackTime` ignored
  what a batch costs; $ per GB-second parked a big fleet on the cheapest server;
  and income-with-the-whole-fleet handed the winner the fattest bite it could take
  and spilled only the remainder, spending most of a large fleet on the worst
  gigabytes of one server. Simulated against nine targets the split earns 5–12%
  more up to 100TB and ~45% more at 200–400TB; on a fleet big enough to saturate
  every target the two agree.
- **One target cannot absorb a big botnet.** Its launch interval is fixed by
  timing, so it pays at most `maxHackFraction` of its money every ~1.2s however
  much RAM exists. Up to `hacking.maxTargets` targets are worked, each within its
  share (a further target is only opened for `hacking.minTargetRam` or more), with
  its own launch clock, prep and drift state. When there are more candidates than
  slots and RAM to spare, the slots go to the targets that can earn the most
  rather than the most RAM-efficient ones.
- A target already being worked gets an edge when the split is re-cut
  (`hacking.targetStickiness`), and one that would first have to be prepped is
  marked down by how long that takes (`hacking.prepHorizonMs`) — so a small fleet
  fresh from an install starts on a server it can prep in minutes, not on the
  richest one in reach.
- Prep is one joint weaken+grow pass sized so the weaken also covers the grow's
  own security (`prepPlan`), and it does **not** block the loop: the manager keeps
  ticking (share, the other targets) and simply doesn't launch against that target
  until its legs land. A target that can't plan a cycle at all (mid-prep, or a
  botnet too small) claims its whole budget, so a prep is never starved by the
  targets below it.
  A prep always grows to **full** money, even from inside the 95% "prepped"
  threshold — a target that starts batching at 96% stays at 96%.
- While batches fly, the target is checked against the worst case one open batch
  can explain (`driftDetected`). Drift **latches** (`stillDraining`): nothing more
  is launched until every batch in flight has landed (a weaken-time), and then the
  target is re-prepped. Unlatched, launching resumed the moment a grow put the
  reading back in bounds, and the target flapped Draining/Batching without ever
  being re-prepped.
- Without Formulas.exe the `ns.*` analysis calls all describe the target at its
  **current** security. They are scaled to min security with the game's own
  formulas (`preppedScale`), so the fallback also sizes and times its batches for
  the prepped state; all it lacks is the hack's success chance (taken as 1 for
  ranking).
- The faction-rep share (`ns.share`, `CONFIG.share`) takes only **free** RAM: it
  never kills a batch leg to make room. A planned host is topped up as its legs
  land (`shareTopUp`), and the part of the plan not yet running is held out of the
  botnet's view of that host so nothing new lands in its way.
- One network snapshot per tick; rooting, script copies and target re-ranking are
  throttled (`networkRescanMs`, `rootRetryMs`, `targetRescoreMs`).
- The loop body is exported as `step(ns, state, now)`, so
  [`tests/batcher-sim.test.mjs`](tests/batcher-sim.test.mjs) drives the whole
  scheduler under Node against a fake `ns` (a model network whose money, security
  and leg durations respond to landings) and asserts the promises above: every
  hack lands on a prepped server, launches are continuous and never exceed the
  depth, the drift detector is quiet in a clean run, latches on a nudge and
  recovers from an outside hit, prep converges monotonically (one pass with ample
  RAM) and tops money up to full, a share start-up kills no batch leg and fills to
  its plan, a halved weaken rate still lands every hack on min security, and — the
  reason the spill exists — a 16TB botnet whose only reachable targets are
  n00dles-alikes earns several times more, on several times the RAM, than the same
  world limited to one target. The fake's dependence on security is the game's own
  formulas, and every scenario runs on both the Formulas and the `ns.*` path.

After syncing a change to **any** helper, run `run /tools/kill-helpers.js all` before
restarting: helpers run off-home, so `killall` on home leaves the old copies running
and the daemon — seeing them "already running" — never launches the new code. `all`
is derived from `CONFIG.paths`, so it covers every helper the daemon can place (the
HUD, stocks, contracts, econ, hacknet and the corp phases included).

The purchased-server buyer ([`lib/pserv.js`](lib/pserv.js)) spends its budget one
purchase at a time on the best **RAM per dollar** on offer. Where cloud RAM is priced
flat that is still "the largest tier we can afford"; on a softcap curve (BN7: $/GB
doubles with every doubling past 64GB) it fills the slots small and levels them up,
which is roughly three times the RAM for the same money.

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
  reusable in any bitnode with SF2 gang access. Its decisions are the pure, tested
  [`lib/gang-logic.js`](lib/gang-logic.js):
  - **Territory by the tick.** Power is credited only at the 20-second territory
    tick, and only from members on Territory Warfare at that instant. So the manager
    follows the tick (another gang's power changing marks it; processed gang time
    from `ns.gang.nextUpdate()` predicts the next) and sends the *whole* roster to
    warfare for the one update that contains it — twice the power of a standing
    half-roster crew for a tenth of the income instead of half.
  - **Ascension on a falling bar** (`gang.ascendThresholds`): x1.63 for a fresh
    member down to x1.06 past x8, one member per update. A flat x1.5 was out of
    reach for anyone past ~x4.
  - **Training through the early ascensions.** Once the roster is full, the lowest
    multipliers (up to `gang.maxTrainFraction`) keep training until
    `gang.trainUntilAscMult`; the rest earn.
- `bn9/daemon.js` — BN9 (Hacktocracy): the hacknet-server fleet is the economy (see
  below); installs are batched bigger, hashes are sold before every reset, and idle
  time studies toward the world daemon's doubled hacking gate.
- `bn6/daemon.js` — BN6 (Bladeburners): the cold boot already gyms every combat stat
  to 100 and joins the division ([`early/blade-boot.js`](early/blade-boot.js), launched
  by the driver wherever `bladeburner.enabled`), then the daemon gives the player's
  work slot to Bladeburner. Rest phases calm a chaotic city (Diplomacy) or tighten
  loose estimates (Field Analysis) first, and otherwise sit in the Regeneration
  Chamber: its +1% of max stamina a minute is as much as passive regen itself once
  max stamina is in the hundreds, so it roughly halves the rest
  (`bladeburner.restInChamber`). Incite Violence is never used — it adds
  `10 + chaos/log10(chaos)` chaos to *every* city. The work runs in two
  off-home helpers — [`lib/bladeburner.js`](lib/bladeburner.js) (contracts, operations,
  black ops, stamina rests, per-action level control; placed ahead of the sleeve
  manager) and [`lib/blade-upkeep.js`](lib/blade-upkeep.js) (skill points, city, the
  Bladeburners faction) — with the decisions in the pure, tested
  [`lib/bladeburner-logic.js`](lib/bladeburner-logic.js). The slot is lent to faction
  work only while Bladeburner rests; other factions' rep is otherwise the sleeves'
  job. Operation Daedalus (which ends the node) is held unless FINISH is on and a
  next node is passed (`run bn6/daemon.js 7`); then `lib/finish-bn.js` runs in
  "blade" mode. Once The Blade's Simulacrum is installed, both run side by side.
  The strategy itself is the shared [`lib/blade-daemon.js`](lib/blade-daemon.js);
  `bn6/daemon.js` is `runBladeDaemon(ns, forNode(6))`.
- `bn7/daemon.js` — BN7 (Bladeburners 2079): the same engine as BN6
  (`runBladeDaemon(ns, forNode(7))`) with Bladeburner's own penalties priced into
  `BITNODE[7]`. Verified against bitburner-src: BN6's table plus `ScriptHackMoney`
  0.5, `AugmentationMoneyCost` 3, `BladeburnerSkillCost` 2 and 4S at 2x; `BladeburnerRank`
  stays 0.6. So skill points concentrate on the every-action levers (Blade's Intuition,
  Overclock, Reaper, Evasive System, Digital Observer; Datamancer 0, Tracer capped),
  Hands of Midas keeps a real weight because contract money is real income here,
  and installs batch bigger (`augs.install`). SF7 buffs the four `bladeburner_*`
  multipliers (+8/12/14%) and SF7.3 installs the Simulacrum on joining, so by
  default the node **re-enters itself until SF7.3** (`bladeburner.reenterUntilSF`,
  `plannedNodeAfterBlade`); the HUD's FINISH toggle still holds Operation Daedalus,
  and a daemon arg overrides the plan. Sleeves work for the division on both
  Bladeburner nodes — see [Sleeves](#sleeves).

Three things about resets that the daemons rely on, all verified against
bitburner-src:

- **Per-node config only reaches code that asks for it.** `BITNODE[n]` overrides
  apply through `forNode(n)`; a module that captures `CONFIG.section` at module scope
  runs on the defaults forever. That is how BN7's skill weights and BN7/BN9's install
  thresholds sat dead in the config. `tests/config-captures.test.mjs` now fails on
  any such capture of an overridden key, and off-home helpers take the node as an
  exec arg.
- **A reset callback gets no arguments and must fit in RAM.** So the next-BitNode arg
  (`run bn7/daemon.js 10`, or `0` to hold) is remembered in `/data/next-bn.txt` for
  the rest of the BitNode (`nextBNOverride`; `run <daemon> auto` forgets it), and
  the finisher's callback is always the cold-start driver.
- **`globalThis` survives installs and BitNode changes** (only a page load clears
  it). The core deletes the state that gates irreversible decisions at boot, and
  readers of helper state check its age.

The aug to **work toward** is the one worth the most per unit of time
([`lib/aug-value.js`](lib/aug-value.js)), not the one with the soonest ETA. An
aug's value is a weighted sum of ln(multiplier) over its stats, with the weights
per node (`augs.value.weights`: hacking first by default, combat and the
Bladeburner multipliers in BN6/7, hacknet in BN9) plus a flat `special` value for
effects that aren't multipliers. A candidate is scored on the whole **bundle** its
reputation unlocks — every cheaper aug the same faction sells comes with the
grind — over the wait for it, and the current target gets a 25% bonus so rate
noise can't flip the work slot. The stat table comes from a one-shot off-home
helper ([`lib/aug-stats.js`](lib/aug-stats.js), 11.6GB for a second, once per page
load); until it has run every aug counts the same. Hover a PIPELINE row on the HUD
for an aug's value. This decides where the work slot and savings go, not what is
bought: everything ready is still bought.

Augmentations are bought **dearest first** (`nextAugPurchase`): every purchase raises
the price of everything still unbought by 1.9x, so {100, 50, 10} costs 231 in that
order and 466 cheapest-first. While a ready aug is unaffordable but within
`augs.saveHorizonMs` of income, nothing cheaper is bought — the status line says what
is being saved for — and NeuroFlux is left to the pre-install dump while any real aug
remains.

Installs follow `augs.install` for the node (`installReason`): the default is 5
queued (2 with a priority aug); BN7 and BN9 batch 8 / 4 with a floor of 4. An
install first asks the stock trader to liquidate (the market is wiped by a reset)
and waits up to a minute for it.

Reputation is **bought** where a faction takes donations (favor at
`ns.getFavorToDonate()`, 150 x the node's multiplier): an aug whose only gap is
reputation with such a faction rides the same dearest-first list, costed at price +
donation (`donationCost`; Formulas.exe gives the exact rate, without it the first
donation is a $1m probe), and the donation is made only at the moment the aug is
bought — both must fit above `gordMoneyFloor`, or be within the save horizon. The
pre-install NeuroFlux dump buys the reputation its extra levels need the same way.
Two things get a faction to that favor: the **`favor` install reason** — with
something queued, an install that would itself carry the faction being ground over
the threshold fires early when at least `favorMinGrindMs` of grind is left and income
buys that reputation in a quarter of the time (BN7/BN9 want 2 queued; BN9 also a
6-hour grind and a tenth) — and **idle rep banking** (`pickFavorBankFaction`), which
takes the idle slot ahead of crime for a faction still selling a wanted aug, or for
one NeuroFlux seller until a donor exists. The favor curve is the game's own,
transcribed in `lib/aug-targets.js`; the whole feature costs the daemon 6.1GB
(`donateToFaction` 5, `getFactionFavor` 1, `getFavorToDonate` 0.1).

[`lib/daemon-lib.js`](lib/daemon-lib.js) holds the building blocks that are
identical across every node: rooting, darkweb buys, accepting invites, off-home helper
placement, the gang manager's placement, faction work, `buyAugs`, the install policy,
and the purchased-server budget. [`lib/daemon-core.js`](lib/daemon-core.js) holds
the skeleton built from them: `runDaemon(ns, hooks)` is `main()` (the tick loop and
the helper launch order), and `decidePrelude` / `decideNoTarget` / `decideAugFlow`
are the parts of `decideNextPriority` every node shares (train → rep → money → buy).
A node's daemon is then just its strategy prefix plus hooks: `maybeSetupGang` (BN2's
-9 shortcut vs BN5's active karma grind vs everyone else's passive snap-up),
`plannedNextBN`, extra helpers, the status line. Every daemon is on the core;
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

## IPvGO

[`lib/go.js`](lib/go.js) is an off-home helper (9.6GB, launched `optional` by every
daemon next to the contract solver) that plays the IPvGO subnet game back to back
for the whole node. IPvGO needs no Source-File, and each finished game adds *node
power* for the faction played, which multiplies one stat: Tetrads the four combat
stat levels, Daedalus faction and company reputation gain, The Black Hand hacking
money, Illuminati hack/grow/weaken speed, Netburners hacknet production, Slum
Snakes crime success. The bonus is `1 + ln(p+1)·(p+1)^0.3·0.002·power` — about +8%
combat stats at 1,000 node power against Tetrads and +20% at 10,000 — and a game
pays black's score × `(komi+0.5)/4` × a win-streak multiplier (up to 3×; 0.5× for
a loss). **An aug install resets node power to zero**, which is why this is a
standing helper rather than a one-off: the bonus is re-earned after every reset.
(Favor from win streaks — 500 rep-worth per second consecutive win against a
faction you belong to — does survive.)

- **RAM.** Only `getBoardState` and `makeMove` cost anything (4GB each). The
  analysis calls — `getChains`, `getLiberties`, `getControlledEmptyNodes` at 16GB
  each and `getValidMoves` at 8GB — are never used: the pure, unit-tested
  [`lib/go-logic.js`](lib/go-logic.js) derives chains, liberties, legality (suicide
  and the game's positional-superko repeat rule, checked against the free
  `getMoveHistory`), territory and eyes from the board itself. Its legality agrees
  with the game's own `evaluateIfMoveIsValid` on every point of every position it
  was compared on.
- **The player** scores each candidate by the position it leaves: a Voronoi
  territory estimate (which stones each empty point is nearest) in which chains
  short of liberties claim nothing, plus what is hanging in atari on either side,
  captures, liberties gained, connections and new eyes. The best few are then
  re-ranked by the opponent's best reply to each (the faction AIs always capture
  what is capturable). It never fills its own eyes or sealed territory, never
  plays into small sealed enemy territory, and passes when nothing is worth a
  point — or when the opponent has passed and it is ahead, which banks the win
  and the streak.
- **Who it plays** is `go.opponents` in [`lib/config.js`](lib/config.js), a
  weighted rotation resolved per node: Daedalus / The Black Hand / Illuminati by
  default, **Tetrads 3 : Daedalus 1 in BN6/BN7**, where combat stats are the
  Bladeburner success chance. A game found in progress is always finished rather
  than reset, because abandoning one breaks the win streak.
- **Strength**, measured against the game's own faction AIs (`goAI.ts`, run
  headless outside the game, 50–200 games each) on 13×13: ~98% against The Black
  Hand, ~90% Netburners, ~85% Daedalus, ~70% Slum Snakes, ~60–65% Tetrads, ~50%
  Illuminati (which starts with five stones down). Batches of 50 scatter by ±10
  points, and none of it has been measured in the live game yet. The board size
  matters more than any weight: komi is a fixed number of points, and the same
  player wins ~45% against Tetrads on 9×9.

It publishes `globalThis.gordGoState` (opponent, wins/losses, the last result, the
game's per-faction bonus percentages), which the HUD's **GO** tab
([`ui/go.js`](ui/go.js)) shows, and writes at most one journal line per 15
minutes. `go.enabled: false` hands the board back for manual play.

## Sleeves

[`lib/sleeves.js`](lib/sleeves.js) is an off-home helper launched by **every** daemon
(it's ~72GB of `ns.sleeve.*` at 4GB a method, so it never shares home, and it's
launched `optional` outside BN10 so it waits quietly until a host has room). It
self-exits where sleeves
are unavailable, so launching it everywhere is inert on nodes that can't use it.

Every sleeve clears **shock** (zero is what unlocks buying it augmentations — the
game refuses while shock > 0), then **synchronizes** to 100, then earns. Full shock
recovery is ~18.5 hours from the 100 every sleeve starts a BitNode with, and only exp
gain depends on shock, so the gate is per mode: the gang bootstrap starts at
`sleeves.gangShockBelow` (85), Bladeburner mode starts immediately
(`sleeves.blade.workShockBelow` — nothing a sleeve does for the division needs exp or
sync), and only mirroring waits for zero. Shock keeps decaying passively while they
work. What "earns" means depends on the gang:

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
- **Bladeburner** — on the Bladeburner nodes (BN6/7, `bladeburner.enabled`), once
  the player is in the division and the action loop is publishing. Contract and
  operation *attempts* are those nodes' real time gate (natural regen is one
  `growthFunction()` per 480s), and a sleeve on **Infiltrate Synthoids** adds
  `n^-0.5 / 2` attempts to every contract and operation each minute (`sqrt(n)/2` in
  total for `n` sleeves). A sleeve that clears `sleeves.blade.minContractChance` on a
  contract — its *own* stats, via `getActionEstimatedSuccessChance(..., sleeveNumber)`
  — runs **Take on contracts** instead, which pays the player's rank and money exactly
  as the player's attempt would (one sleeve per contract name, so at most three).
  The split is the pure `planSleeveBladeWork` in
  [`lib/bladeburner-logic.js`](lib/bladeburner-logic.js): sleeves keep a still-viable
  contract, each unclaimed contract goes deepest-queue-first to the best free sleeve,
  everyone else infiltrates. General actions act on the *division*, whoever performs
  them, so the sleeves off contracts also **support the player**: while the player's
  stamina is under `sleeves.blade.regenBelow` they sit in the Regeneration Chamber
  (each restores 1% of the player's max stamina per minute, which keeps the player
  out of rest phases altogether rather than shortening them), and while city chaos
  is past the Diplomacy threshold they run Diplomacy. Attempt counts come from `gordBladeState.contractCounts`
  (published by `lib/bladeburner.js`) so the manager pays for one Bladeburner getter,
  not three. It outranks mirroring but not the gang bootstrap: a couple of hours of
  sleeve homicide buys an income that lasts the whole node. **Support main sleeve** is
  used for black ops only: a supporting sleeve counts into the team (`(team+1)^0.05`
  success — about +10% for six) and, unlike a recruit, can't be lost, so the whole
  roster joins when that bonus would carry a rank-ready black op over its bar and goes
  back to work when it's done (`nextSleeveSupportState`).

**Augmentations** are bought everywhere, cheapest-first across the roster, once cash
clears `sleeves.augMinMoney` — in batches of `sleeves.augBatchMin` per sleeve (or
all it has left), because installing an aug on a sleeve zeroes its exp. **Buying sleeves and memory** only works in BitNode 10,
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

Money discipline, because the offer is a share of a valuation that prices
`Funds/3 + max(AssetDelta, 0) × 315000` averaged over 10 cycles:

- **A ready round is held, not sold on the spot** (`offerHold` in `corp-invest`),
  and while it is held *every* spender stands down — corp-steady's Wilson/Advert/
  upgrades, corp-expand's purchases, corp-office's seats and Advert, round-3+ boost
  orders. Tea/parties and product development carry on, and rounds 1–2 boost
  orders deliberately keep going: there they are the round's closing move and
  cost no AssetDelta. The hold flag is only honoured while
  corp-invest keeps re-stamping it (`offerHoldActive`), so a rotation that stops
  placing corp-invest can't freeze the corp.
- **corp-steady spends once per cycle**, on the START tick (`isSpendTick`) — it used
  to run every budget fraction on all five states.
- **Boosts**: in rounds 1–2 nothing is ordered until the division has banked its RP
  (it produces nothing before that, and debt blocks tea, parties and every seat);
  from round 3 a pass may commit only `boostBudgetFraction` of the surplus above
  the reserve and the banked objective (`boostSpendBudget`) — the order used to be
  sized by the warehouse alone, i.e. bought on credit.
- **Round-2 order**: Export is tried before Smart Supply (`optionalUnlockOrder`), and
  in rounds 1–2 Agriculture's warehouse climb leaves untouched what the offices
  still need for seats + Advert (`gordCorpOfficeNeed` → `warehouseClimbFloor`).

Other mechanics: **products are priced without Market-TA.II**
(`nextProductPrice` in `corp-steady`, 0 extra RAM) — each cycle the last SALE's own
figures give the price that sells the shelf, `MP + (P − MP)·√(sold / target)`,
probing upward while it sells out; TA.II takes over if it's ever researched.
**Manual input orders** (before Smart Supply) follow consumption minus imports
(`orderRate`), not just the shortfall, so they neither cap production nor buy on
the market what an export route delivers. **Export routes are kept in config
order** (`exportPlan`) — the game serves them FIFO and has no reorder, so a route
added later is cancelled and re-created behind Tobacco's. **Support divisions
research from their own list** (`researchPrioritySupport`, no Market-TA bundle).
The build phases skip their pass until corp-invest has published the round
(`roundKnown`), and the daemon journals a warning when a phase has found no RAM
for `phaseMissWarnRotations` rotations.

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

**FINISH: AUTO / OFF.** Off, the daemon runs exactly as normal but never ends the
node. That takes two things, because a scripted backdoor on `w0r1d_d43m0n` opens the
BitVerse by itself: `lib/backdoor.js` never backdoors the world daemon on any node
(it only reports when it is *ready* - rooted, hacking level met - and
`destroyW0r1dD43m0n` needs nothing more), and the finisher is held. Enforced in
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

The pure (`ns`-free) logic modules — capabilities, contract solvers, batch / hacknet /
grafting / crime / Bladeburner logic, the corp planners, the install policy and the
server buyer's choice rule — have Node unit tests under [`tests/`](tests/), plus an
end-to-end simulation of the batcher and a lint for config captures. With Node ≥20:

```bash
npm test
```

This runs `node --test tests/*.test.mjs`. The game itself needs no build step; Node
is only used to test the pure logic. Everything that touches `ns` stays in the
importing module (e.g. `lib/grafting.js` gathers game data, then delegates the
graft-vs-crime decision to the pure `lib/grafting-logic.js`).

