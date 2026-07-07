Bitburner scripts for my playthrough. 

## BitNode entry points

Each bitnode gets a thin `bnX/daemon.js` orchestrator; everything reusable lives in `lib/`.

- `bn4/daemon.js` — BN4 (Singularity): faction/aug pipeline, backdoors, install loop.
- `bn2/daemon.js` — BN2 (gangs): bootstraps Slum Snakes (30 combat stats, -9 karma, $1M),
  creates the gang, then launches `lib/gang.js` on whatever server has ~35GB free.
- `lib/gang.js` — standalone BN-agnostic gang manager (recruit/ascend/equip/tasks/territory);
  reusable in any bitnode with SF2 gang access.

