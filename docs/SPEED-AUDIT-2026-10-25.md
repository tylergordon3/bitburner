# Speed audit, 2026-10-25

Where the campaign loses wall-clock time, and what would win it back. Four reviewers
(hacking-finish nodes, Bladeburner-finish nodes, the campaign order, the live BN8 run)
read the saves of 2026-10-18 to 2026-10-25 and checked every mechanic against the game
the user runs, **v3.0.1**. Hour estimates come from formula models and saves, not live
runs; "verified" means the code path and the game source were both read.

## How long nodes take now

| Node | Finish | Wall-clock | Notes |
| --- | --- | --- | --- |
| BN13.1 | black ops | ~69.5h | 409 rank in the first 37.5h (the 10-18 stall) |
| BN14.1 | black ops | ~61.5h | finished ~1h after the 23ee3bb fixes, on ~20h of stored bonus time |
| BN11.1 | hacking | ~34.7h | |
| BN8.1 | hacking | 15h+ so far | install deadlock until af5e834; est. 40-50h more as the code stands |

About 30 runs plus BN12 to level 50 remain. Offline time (the game closed) is not
counted here.

## The big ones

### 1. BN12 at level-1 difficulty, every run (campaign; verified)

BN12's multipliers scale with the **active** SF12 level (`BitNode.tsx:1130`,
`activeSourceFileLvl`), and BitNode options may override any Source-File down to 0
(`BitNodeUtils.ts:54-63`). The reward and the level-50 achievement both read the
**owned** level (`RedPill.tsx:25-34`, `Achievements.ts:674`). So every BN12 run can be
entered with `sourceFileOverrides {12: 0}` and played at level-1 difficulty while
still counting toward 50. The only cost: no free NeuroFlux levels inside BN12 itself.

Without it, BN12 at level 50 has hacking x0.37 against a world daemon at 8,070 and
income ~x0.05: run time grows several-fold. With it, 50 runs x ~20h is realistic.
Estimated saving: 300h to over 2,000h across the 49 runs.

What it needs: `getResetInfo().ownedSF` reports the ACTIVE level, so inside an
override run the bot would see SF12 = 0 and re-enter BN12 for ever. The campaign step
must take the owned level from elsewhere (the save, which `lib/achievements.js` already
reads, or a file the finish writes).

It also opens a strategic choice: each SF12 level adds a NeuroFlux level (+1% to
almost every multiplier) to every LATER node (`Prestige.ts:264-269`), so 49 levels is
~x1.63 everywhere. Front-loading `[12, 50]` makes every remaining run faster, at the
price of ~1,000 hours spent there first.

### 2. Installs after The Red Pill (hacking nodes; verified)

`installReason` special-cases The Red Pill only while it is queued (`daemon-lib.js:1307`).
Once installed, any new aug - or NeuroFlux, bought when nothing else is left - triggers
another install, which resets hacking exp while the node is climbing to the world
daemon's level. Worst on the default policy (one queued aug is enough). Change: after
The Red Pill is installed, no install at all.

### 3. Hacking exp is never farmed outside BN8 (hacking nodes; verified)

Exp per thread is 3 + 0.3 x the server's base difficulty, whatever its money
(`Hacking.ts:30-37`), and fast servers give it ~40x faster per GB-second than the
money targets (BN11 26h save: joesguns 88 vs 2.2 exp/GB-s). The batcher already has an
exp objective (`rankForStocks`, BN8 only) and big fleets sit 1-13% used. Change: idle
RAM farms exp in every node, and the whole botnet switches to exp once level is the only
gate (after The Red Pill; Daedalus's hack-2500 gate). Estimate 1-3h a node; required for
high BN12 levels.

### 4. The Daedalus / Red Pill path (hacking nodes; verified code, plausible hours)

- The plain and gang daemons never hoard the $100b Daedalus invite money; it arrives
  only once nothing is left to buy.
- Nothing holds installs while Daedalus is joined and The Red Pill is unbought; each
  install wipes its reputation and re-imposes the invite gates. BN11's hour-26 install
  threw away a Daedalus membership (45.5 favor in the save, not a member).
- IPvGO wins against Daedalus raise its favor directly while a member.

Change: hoard for Daedalus in every daemon (as lib/blade-daemon.js does), a "Daedalus
lock" (only the red-pill install, or a favor install to the donation threshold), the Go
helper on Daedalus during the lock, then donate. Estimate 3-8h a node.

### 5. Bladeburner: Raid, the karma bootstrap, the black-op bar (blade nodes)

- **Raid is never run** (`config.js` operations list). It pays ~4.7x Assassination's rank
  per attempt at equal difficulty, while the city has communities (`Operations.ts`).
  Sim: BN15 141h -> 94h, 10k rank 2-4x sooner. Plausible; ~130-200h over 8 runs.
- **Sleeves mug for gang karma 25-45h a run**: `crime-logic.js` drops crimes under
  50% chance even when ranking by karma, so sleeves at str 77 mug (0.06 karma/s) instead
  of Homicide at 39% (0.39/s). Verified; 5-15h a BN13/14 run, 15-35h a BN15 run.
- **The black-op bar**: a flat 0.55 still holds early ops at 40% (Typhoon) and is too
  low for Vindictus in BN15 (a failure costs 20k rank, unscaled). Gate on failure cost
  vs current rank rate instead. BN15 -20 to -45h a run.
- Skill weights: Hands of Midas / Cyber's Edge / Hyperdrive take 15-20% of points for
  no rank. No installs in a node's finishing stretch (stats reset to 1). Infiltration
  capped at 2 sleeves (sqrt scaling).

### 6. BN8 (the live run; verified)

- **Compute is frozen**: purchased servers are capped at $1b a purchase
  (`pserv.hardSpendCap`) and a 512GB step costs $1.58b; home RAM waits for a "full
  fleet" BN8 can never reach (a rule from the 10-23 audit). Home RAM is the only compute
  an install keeps, and 64TB costs ~1 hour of trading. ~15-20h.
- **Augs bought one at a time, cheapest-first** as the allowance arrives: junk first, then
  a 1.82x price climb per aug. Better: buy nothing during the run, then liquidate and buy
  dearest-first at the install. ~8-12h.
- **The player and 8 sleeves earn nothing**: player on Homicide (crime money x0), sleeves
  on gang karma (gang soft cap 0 in BN8). Company work for megacorp factions instead
  (hacking augs). ~5-15h.
- Hold The Red Pill install until the 3000 grind fits in a few hours; NeuroFlux dump first.
- The trader itself is efficient (~40%/h, capped by market size).

## Campaign order

Proposed by the campaign reviewer (if #1 is adopted; otherwise keep `[12, 50]` last):

    8.1 (now), [8 challenge], 11.3, 12 -> 50 (override runs),
    [13 challenge], 13.3, [2 challenge], 2.3, [6 challenge], 6.3, 8.3, 15.3,
    [14 challenge], 14.3, then the challenge-only runs 9, 7, 3, 1, 10

- SF8.2 next: shorting helps stock income everywhere after.
- 11.3 before BN12: the per-aug price climb drops (x1.9 x .96 -> x .93), ~25% off the 10th
  aug of a batch, for 47+ runs.
- Runs whose Source-File speeds nothing later (SF2/6 small mults, SF8.3 limit orders
  unused, SF14.2/3 cheats unused, SF15.2/3 small) go late; challenge-only runs (already at
  level 3) go last, where the NeuroFlux levels help them most. BN10 last: its manual
  finish is the natural slot for `tools/debt.js`.
- Challenges never stack (each requires its own node), but every BN15 run earns
  CHALLENGE_BN15, and the money run can live inside a BN12 run.

## Smaller items

- No run history survives: the journal lives in memory and `last-reset-summary.txt` is
  consumed on read, so every speed question has to be reconstructed from saves. A
  persistent per-install / per-node log file would make the next audit measure instead
  of estimate.
- Daedalus needs only 31-32 augs at the BN12 levels played (comment says "climbs to 40").
- With SF15, the dark-net labyrinth gives The Red Pill in every node but BN8: a labyrinth
  runner would shortcut every hacking finish (large to build).
- Unused SF bonuses: SF8.3 limit orders, SF14.2 IPvGO cheats (both low value).
