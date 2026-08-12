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

## BitNode entry points

Each bitnode gets a thin `bnX/daemon.js` orchestrator; everything reusable lives in `lib/`.

- `bn4/daemon.js` — BN4 (Singularity): faction/aug pipeline, backdoors, install loop.
  The reference implementation — the other four are this plus one special system.
- `bn2/daemon.js` — BN2 (gangs): bootstraps Slum Snakes (30 combat stats, -9 karma, $1M),
  creates the gang, then launches `lib/gang.js` on whatever server has ~35GB free.
- `lib/gang.js` — standalone BN-agnostic gang manager (recruit/ascend/equip/tasks/territory);
  reusable in any bitnode with SF2 gang access.

[`lib/daemon-lib.js`](lib/daemon-lib.js) holds everything that was identical across
all five: rooting, darkweb buys, accepting invites, off-home helper placement, the
gang manager's placement, faction work, `buyAugs`, the install policy, and the
purchased-server budget. Each daemon still owns what genuinely differs —
`decideNextPriority` (the node's strategy), `maybeSetupGang` (BN2's -9 shortcut vs
BN5's active karma grind vs everyone else's passive snap-up), `plannedNextBN`, and
`main()`'s wiring. Note this is a *maintainability* win, not a RAM one: Bitburner
sums a script's cost over its whole import closure either way. RAM savings come from
moving work into off-home helpers, which is why `lib/` is full of them.

## Capabilities

[`lib/capabilities.js`](lib/capabilities.js) centralizes "which gated API is usable
this run" into one **0GB** check (it reads `ns.getResetInfo()`, which is free).
Every Source-File/BitNode-gated API — Singularity, Gang, Corporation, Sleeves,
Grafting, Bladeburner, Hacknet-Server, Stanek — is available when you're in its
BitNode *or* hold its Source-File, so this replaces scattered `try/catch` probes
with `getCapabilities(ns)`. The decision logic is pure (`sourceFileLevel`,
`hasApiAccess`, `singularityRamMultiplier`, `capabilitiesFromReset`) and unit-tested.

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
where The Covenant sells them, so those steps are gated on `sleeves.shopBitNode`.

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

The GORDNET header carries two switches. Each is a `globalThis` boolean the HUD
assigns and a daemon reads — a click handler can't call `ns` without stopping the
script, so that indirection is the whole mechanism.
[`lib/toggles.js`](lib/toggles.js) adds the durability: each value is mirrored to a
one-word file (`CONFIG.paths.focusFile` / `autoFinishFile`) and re-seeded from it,
because both an aug install and a page reload wipe `globalThis`, and a switch you
deliberately turned off silently turning itself back on hours later is exactly what
these exist to prevent. Both default **on** — the behaviour from before they existed.

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
`lib/grafting-logic.js`, `lib/crime-logic.js` — have Node unit tests under
[`tests/`](tests/). With Node ≥20:

```bash
npm test
```

This runs `node --test tests/*.test.mjs`. The game itself needs no build step; Node
is only used to test the pure logic. Everything that touches `ns` stays in the
importing module (e.g. `lib/grafting.js` gathers game data, then delegates the
graft-vs-crime decision to the pure `lib/grafting-logic.js`).

