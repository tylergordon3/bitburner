// lib/aug-targets.js

export const FACTION_PRIORITY = [
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
];

export const FACTION_REQUIREMENTS = {
  "Slum Snakes": {
    strength: 30,
    defense: 30,
    dexterity: 30,
    agility: 30,
  },
  "Tetrads": {
    strength: 75,
    defense: 75,
    dexterity: 75,
    agility: 75,
  },
  "Speakers for the Dead": {
    strength: 300,
    defense: 300,
    dexterity: 300,
    agility: 300,
  },
  "The Dark Army": {
    strength: 300,
    defense: 300,
    dexterity: 300,
    agility: 300,
  },
  "The Syndicate": {
    strength: 200,
    defense: 200,
    dexterity: 200,
    agility: 200,
  },
};

/** @param {NS} ns */
export function getNextAugTarget(ns) {
  const s = ns.singularity;
  const player = ns.getPlayer();

  const owned = new Set(s.getOwnedAugmentations(true));
  const installed = new Set(s.getOwnedAugmentations(false));
  const joined = player.factions ?? [];

  let best = null;

  for (const factionName of joined) {
    const faction = /** @type {any} */ (factionName);
    const rep = s.getFactionRep(faction);

    for (const aug of s.getAugmentationsFromFaction(faction)) {
      if (aug === "NeuroFlux Governor") continue;
      if (owned.has(aug)) continue;

      const prereqs = s.getAugmentationPrereq(aug);
      if (!prereqs.every(a => owned.has(a) || installed.has(a))) continue;

      const repReq = s.getAugmentationRepReq(aug);
      const price = s.getAugmentationPrice(aug);

      const repMissing = Math.max(0, repReq - rep);
      const moneyMissing = Math.max(0, price - player.money);

      const canBuy = repMissing <= 0 && moneyMissing <= 0;

      const priorityIndex = FACTION_PRIORITY.indexOf(factionName);
      const softPriority = priorityIndex === -1 ? 25 : priorityIndex;

      const score =
        repMissing * 250_000 +
        moneyMissing +
        price * 0.25 +
        softPriority * 10_000_000;

      // AFTER:
      const candidate = {
        faction,
        aug,
        repReq,
        rep,
        price,
        repMissing,
        moneyMissing,
        canBuy,
        score,
      };

      if (!best) {
        best = candidate;
      } else {
        // Three-tier priority:
        //   1. canBuy (rep done, money done) — always wins
        //   2. repDone (rep done, money missing) — beats anything still needing rep
        //   3. everything else — lowest score wins
        const repDone    = repMissing <= 0;
        const bestRepDone = best.repMissing <= 0;

        if (canBuy && !best.canBuy) {
          best = candidate;
        } else if (!canBuy && best.canBuy) {
          // keep best
        } else if (repDone && !bestRepDone) {
          best = candidate; // rep-done beats rep-missing even at lower priority
        } else if (!repDone && bestRepDone) {
          // keep best
        } else if (score < best.score) {
          best = candidate;
        }
      }
    }
  }

  return best;
}