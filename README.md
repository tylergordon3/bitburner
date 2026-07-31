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
- `bn2/daemon.js` — BN2 (gangs): bootstraps Slum Snakes (30 combat stats, -9 karma, $1M),
  creates the gang, then launches `lib/gang.js` on whatever server has ~35GB free.
- `lib/gang.js` — standalone BN-agnostic gang manager (recruit/ascend/equip/tasks/territory);
  reusable in any bitnode with SF2 gang access.

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
`lib/grafting-logic.js` — have Node unit tests under [`tests/`](tests/). With Node ≥20:

```bash
npm test
```

This runs `node --test tests/*.test.mjs`. The game itself needs no build step; Node
is only used to test the pure logic. Everything that touches `ns` stays in the
importing module (e.g. `lib/grafting.js` gathers game data, then delegates the
graft-vs-crime decision to the pure `lib/grafting-logic.js`).

