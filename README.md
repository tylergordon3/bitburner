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

## BitNode entry points

Each bitnode gets a thin `bnX/daemon.js` orchestrator; everything reusable lives in `lib/`.

- `bn4/daemon.js` — BN4 (Singularity): faction/aug pipeline, backdoors, install loop.
- `bn2/daemon.js` — BN2 (gangs): bootstraps Slum Snakes (30 combat stats, -9 karma, $1M),
  creates the gang, then launches `lib/gang.js` on whatever server has ~35GB free.
- `lib/gang.js` — standalone BN-agnostic gang manager (recruit/ascend/equip/tasks/territory);
  reusable in any bitnode with SF2 gang access.

