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
  const owned = new Set(ns.singularity.getOwnedAugmentations(true));
  const joined = new Set(ns.getPlayer().factions);

  let best = null;

  for (const factionName of FACTION_PRIORITY) {
    if (!joined.has(/** @type {any} */ (factionName))) continue;

    const faction = /** @type {any} */ (factionName);

    const augs = ns.singularity
        .getAugmentationsFromFaction(faction)
        .filter(a => !owned.has(a))
        .filter(a => a !== "NeuroFlux Governor");

  for (const aug of augs) {
      const repReq = ns.singularity.getAugmentationRepReq(aug);
      const price = ns.singularity.getAugmentationPrice(aug);
      const rep = ns.singularity.getFactionRep(faction);

      const repMissing = Math.max(0, repReq - rep);
      const moneyMissing = Math.max(0, price - ns.getPlayer().money);

      const score =
        repMissing * 100 +
        moneyMissing / 1e6 +
        FACTION_PRIORITY.indexOf(faction) * 10000;

      if (!best || score < best.score) {
        best = {
          faction,
          aug,
          repReq,
          rep,
          price,
          repMissing,
          moneyMissing,
          score,
        };
      }
    }
  }

  return best;
}