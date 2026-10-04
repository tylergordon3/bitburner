// lib/stanek-logic.js
//
// The PURE half of the Stanek's Gift automation: which fragments are worth
// placing, where they go, which one to charge next, and which hosts the charge
// workers should hold. No `ns` anywhere, so it costs 0GB and is unit-tested under
// Node (tests/stanek-logic.test.mjs). lib/stanek.js is the Netscript I/O shell
// around it; early/stanek-boot.js and the daemons use the gate helpers at the
// bottom.
//
// ── The game's rules, as its source implements them (bitburner-src, branch dev,
//    read 2026-10) ──────────────────────────────────────────────────────────────
//   Grid (CotMG/StaneksGift.ts): baseSize = 9 + StaneksGiftExtraSize (a BitNode
//     multiplier) + the active Source-File 13 level; width = floor(base/2 + 1),
//     height = floor(base/2 + 0.6), floored at 2x3 and capped at 25. So BN13
//     (ExtraSize 1) is 6x5 on a first visit and 6x6 / 7x6 / 7x7 at SF13.1/2/3;
//     BN8 (ExtraSize -99) is the 2x3 floor.
//   Fragments (CotMG/Fragment.ts): sixteen STAT fragments, all tetrominoes, limit
//     one each (ids 0 1 5 6 7 10 12 14 16 18 20 21 25 27 28 30), and eight BOOSTER
//     fragments, all pentominoes, limit 99 each (ids 100-107), power 1.1.
//   Rotation (Fragment.fullAt): 0-3 quarter turns. The root (x, y) is the top-left
//     corner of the ROTATED bounding box, and a fragment is addressed by its root
//     everywhere in the API (findFragment matches x and y exactly) - which is why
//     the packer below never lets two placements share a root.
//   Boost (StaneksGift.effect): a stat fragment's power is multiplied by the power
//     of every DISTINCT booster occupying a cell orthogonally adjacent to it.
//     Boosters do not boost each other and cannot be charged (chargeFragment
//     THROWS on one).
//   Bonus (CotMG/formulas/effect.ts):
//       effect = 1 + ln(highestCharge + 1) / 60 * ((numCharge + 1) / 5)^0.07
//                    * power * boost * StaneksGiftPowerMultiplier
//   Charging (StaneksGift.charge), with t = the worker's threads x its host's
//     core bonus (1 + (cores - 1) / 16):
//       t >  highestCharge:  numCharge = highestCharge * numCharge / t + 1
//                            highestCharge = t
//       t <= highestCharge:  numCharge += t / highestCharge
//     Either way highestCharge * numCharge grows by exactly t: nothing is ever
//     lost, the fragment remembers the TOTAL thread-charges it has had and the
//     BIGGEST single one. The bonus is ln() of the biggest and only the 0.07th
//     power of the count, so one 1,000-thread charge (ln 1001 * 0.4^0.07 = 6.5)
//     is worth six times a thousand 1-thread charges (ln 2 * 200^0.07 = 1.0),
//     and for a fixed total a bigger single charge keeps winning until
//     ln(h) > 1/0.07, i.e. ~1.6 million threads. Hence the whole RAM design:
//     few, large worker processes (planChargeHosts), every fragment hit by the
//     largest one (chargeRotation), and smaller workers still welcome - they add
//     t / highestCharge to the count and take nothing away.
//   An aug install zeroes every fragment's charge but KEEPS the layout
//     (prestigeAugmentation -> clearCharge); entering a BitNode clears the gift
//     (prestigeSourceFile -> clear). clearGift / re-placing a fragment makes a new
//     ActiveFragment with zero charge, so re-laying a charged gift throws its
//     charge away - layoutDecision guards that.
//
// ── The layout search ────────────────────────────────────────────────────────
// planLayout maximises  sum over placed stat fragments of  weight x boost,
// where weight comes from a per-node priority table (lib/config.js stanek.profiles)
// and boost is the product above. It is a seeded RUIN-AND-RECREATE search: lay
// the grid out greedily (the placement that adds the most value, again and again,
// so stat fragments go down heaviest-first and each booster lands where it
// touches the most weight), then repeatedly tear out a piece together with some
// of its neighbours, rebuild the hole the same greedy way with a little jitter,
// and keep the result unless it is worse. An anchored exact-cover search packs
// tighter but cannot see the objective - a booster is worth nothing until its
// neighbours exist, so no bound on a partial layout prunes anything - and plain
// annealing over single moves needed 100x the work for worse layouts. Checked
// against an exhaustive search on every grid small enough to enumerate (up to
// 5x4, 760,000 layouts): the optimum each time.
//   BOUND: restarts x iterations rounds (3 x 300 by default), stretched by at
//   most smallGridBoost (4) on grids whose catalog is short. A round is one pass
//   over the placement catalog (every piece x orientation x root: ~2,200 entries
//   on an 8x7 grid) plus a few re-checks of what fitted. No recursion and no
//   loop that waits on finding anything: measured 50-100ms on every grid from
//   4x3 to the 8x7 that is the largest the game produces, once per helper start.
//   The rng is a seeded mulberry32, so the same (fragments, grid, weights,
//   options) always yields the same layout - which is what lets lib/stanek.js
//   recognise its own layout after a restart instead of re-laying it.
//
// NAMING: Bitburner's static RAM analyser bills by identifier NAME, whatever
// object it hangs off. Nothing in this file may be called chargeFragment,
// placeFragment, canPlaceFragment, activeFragments, fragmentDefinitions,
// clearGift, acceptGift, giftWidth, giftHeight, getFragment or removeFragment (or
// exec, kill, ps, scp, run, share, hack, grow, weaken, hacknet, ...), or this 0GB
// module would start charging every importer for them.

import { hasApiAccess } from "./capabilities.js";

// ── Fragment types ───────────────────────────────────────────────────────────

/** CotMG/FragmentType.ts FragmentTypeEnum, under the names lib/config.js uses
 *  for its priority tables. */
export const FRAGMENT_TYPE = {
  hackingSpeed: 3,
  hackingMoney: 4,
  hackingGrow: 5,
  hacking: 6,
  strength: 7,
  defense: 8,
  dexterity: 9,
  agility: 10,
  charisma: 11,
  hacknetMoney: 12,
  hacknetCost: 13,
  rep: 14,
  workMoney: 15,
  crime: 16,
  bladeburner: 17,
  booster: 18,
};

const BOOSTER = FRAGMENT_TYPE.booster;

const NAME_OF_TYPE = new Map(Object.entries(FRAGMENT_TYPE).map(([name, type]) => [type, name]));

/** Short labels for the HUD and the log, by priority-table name. */
const LABEL_OF_NAME = {
  hackingSpeed: "Hack speed",
  hackingMoney: "Hack power",
  hackingGrow: "Grow power",
  hacking: "Hacking",
  strength: "Strength",
  defense: "Defense",
  dexterity: "Dexterity",
  agility: "Agility",
  charisma: "Charisma",
  hacknetMoney: "Hacknet production",
  hacknetCost: "Hacknet cost",
  rep: "Reputation",
  workMoney: "Work money",
  crime: "Crime",
  bladeburner: "Bladeburner",
  booster: "Booster",
};

/** The priority-table name of a numeric fragment type ("strength"), or null. */
export function typeName(type) {
  return NAME_OF_TYPE.get(Number(type)) ?? null;
}

/** A human label for a numeric fragment type ("Strength"). */
export function typeLabel(type) {
  const name = typeName(type);
  return name ? LABEL_OF_NAME[name] : `Type ${type}`;
}

/** @param {{type: number}} fragment */
export function isBooster(fragment) {
  return Number(fragment?.type) === BOOSTER;
}

/**
 * The game's grid for a base size (StaneksGift.width / height). Exported for the
 * tests and for anyone who wants the size of a node's gift before accepting it;
 * lib/stanek.js asks the game instead (0.8GB), because the base size needs the
 * BitNode's StaneksGiftExtraSize, which costs 4GB to read.
 * @param {number} baseSize 9 + StaneksGiftExtraSize + the active SF13 level
 */
export function gridSize(baseSize) {
  return {
    width: Math.max(2, Math.min(Math.floor(baseSize / 2 + 1), 25)),
    height: Math.max(3, Math.min(Math.floor(baseSize / 2 + 0.6), 25)),
  };
}

// ── Geometry (a port of CotMG/Fragment.ts) ───────────────────────────────────

/** Width of `shape` after `rotation` quarter turns (Fragment.width). */
export function rotatedWidth(shape, rotation) {
  return rotation % 2 === 0 ? shape[0].length : shape.length;
}

/** Height of `shape` after `rotation` quarter turns (Fragment.height). */
export function rotatedHeight(shape, rotation) {
  return rotation % 2 === 0 ? shape.length : shape[0].length;
}

/**
 * Whether the rotated shape fills local cell (x, y). A line-for-line port of
 * Fragment.fullAt - the start corner and step direction per rotation, then the
 * axis swap for odd rotations - because the layout this module plans is only
 * correct if it agrees with the game about what "rotation 3" means.
 * @param {boolean[][]} shape @param {number} x @param {number} y @param {number} rotation
 */
export function fullAt(shape, x, y, rotation) {
  const w = rotatedWidth(shape, rotation);
  const h = rotatedHeight(shape, rotation);
  if (y < 0 || y >= h || x < 0 || x >= w) return false;
  let sx = 0, sy = 0, mx = 1, my = 1;
  if (rotation === 1) { sx = w - 1; mx = -1; }
  else if (rotation === 2) { sx = w - 1; sy = h - 1; mx = -1; my = -1; }
  else if (rotation === 3) { sy = h - 1; my = -1; }
  let qx = sx + mx * x;
  let qy = sy + my * y;
  if (rotation % 2 === 1) [qx, qy] = [qy, qx];
  return !!shape[qy][qx];
}

/**
 * The filled cells of a rotated shape, as [x, y] offsets from its root, in
 * row-major order.
 * @param {boolean[][]} shape @param {number} rotation
 * @returns {number[][]}
 */
export function shapeCells(shape, rotation) {
  const cells = [];
  const w = rotatedWidth(shape, rotation);
  const h = rotatedHeight(shape, rotation);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (fullAt(shape, x, y, rotation)) cells.push([x, y]);
    }
  }
  return cells;
}

/**
 * The DISTINCT orientations of a shape: rotations that produce the same cells
 * (the O under any turn, the I and S under a half turn) collapse to the lowest
 * rotation number, so the search never spends proposals on duplicates.
 * @param {boolean[][]} shape
 * @returns {{rotation: number, width: number, height: number, cells: number[][]}[]}
 */
export function orientations(shape) {
  const seen = new Set();
  const out = [];
  for (let rotation = 0; rotation < 4; rotation++) {
    const cells = shapeCells(shape, rotation);
    const key = `${rotatedWidth(shape, rotation)}:${cells.map(c => c.join(",")).join(";")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rotation, width: rotatedWidth(shape, rotation), height: rotatedHeight(shape, rotation), cells });
  }
  return out;
}

/**
 * Grid cells ("x,y" keys are avoided - plain y * width + x indices) a placed
 * fragment occupies. Works for a planned placement plus its definition and for
 * an ActiveFragment from the game alike (both carry x, y, rotation; the shape
 * comes from `shape`).
 * @param {{x: number, y: number, rotation: number}} placed @param {boolean[][]} shape
 * @returns {number[][]} world [x, y] cells
 */
export function cellsOf(placed, shape) {
  return shapeCells(shape, placed.rotation).map(([dx, dy]) => [placed.x + dx, placed.y + dy]);
}

// ── Fragment choice ──────────────────────────────────────────────────────────

/**
 * What a priority table makes of the game's fragment definitions: the stat
 * fragments worth placing (weight > 0), heaviest first, and the boosters.
 *
 * A weight is the worth of having that fragment in the gift, UNBOOSTED, in
 * whatever unit the table likes (only ratios matter); every booster touching it
 * then adds 10% of that. Zero - or a type the table does not name - means "never
 * place it": its cells are better spent on a booster. Two fragments share the
 * Hacking type (ids 0 and 1) and both take the `hacking` weight.
 *
 * @param {{id: number, type: number, power: number, limit: number, shape: boolean[][]}[]} defs
 *        ns.stanek.fragmentDefinitions()
 * @param {Record<string, number>} priorities priority-table name -> weight
 * @returns {{stats: any[], boosters: any[]}} each entry is the definition plus
 *          `weight` and `name`; stats sorted by weight (desc), then id.
 */
export function chooseFragments(defs, priorities) {
  const stats = [];
  const boosters = [];
  for (const def of defs ?? []) {
    if (!def?.shape?.length || !def.shape[0]?.length) continue;
    const name = typeName(def.type);
    if (isBooster(def)) {
      boosters.push({ ...def, name: "booster", weight: 0 });
      continue;
    }
    const weight = Number(name ? priorities?.[name] ?? 0 : 0);
    if (!(weight > 0) || !(def.limit > 0)) continue;
    stats.push({ ...def, name, weight });
  }
  stats.sort((a, b) => b.weight - a.weight || a.id - b.id);
  boosters.sort((a, b) => a.id - b.id);
  return { stats, boosters };
}

/**
 * The weight of one fragment under a priority table (0 for a booster or an
 * unlisted type).
 * @param {{type: number}} fragment @param {Record<string, number>} priorities
 */
export function weightOf(fragment, priorities) {
  if (isBooster(fragment)) return 0;
  const name = typeName(fragment.type);
  const weight = Number(name ? priorities?.[name] ?? 0 : 0);
  return weight > 0 ? weight : 0;
}

// ── Reading a layout ─────────────────────────────────────────────────────────

/**
 * Per placed fragment, the boosters touching it - the game's StaneksGift.effect
 * neighbour walk. `fragments` is anything carrying x, y, rotation, type, power
 * and shape: the game's ActiveFragments, or planned placements joined to their
 * definitions (withDefs).
 * @param {any[]} fragments
 * @returns {{count: number, boost: number}[]} aligned with `fragments`; boosters
 *          themselves report count 0 / boost 1.
 */
export function boostsOf(fragments) {
  /** @type {Map<string, number>} cell -> index of the fragment occupying it */
  const owner = new Map();
  const cells = fragments.map(f => cellsOf(f, f.shape));
  cells.forEach((list, i) => {
    for (const [x, y] of list) owner.set(`${x},${y}`, i);
  });
  return fragments.map((f, i) => {
    if (isBooster(f)) return { count: 0, boost: 1 };
    const touching = new Set();
    for (const [x, y] of cells[i]) {
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const j = owner.get(`${nx},${ny}`);
        if (j !== undefined && j !== i && isBooster(fragments[j])) touching.add(j);
      }
    }
    let boost = 1;
    for (const j of touching) boost *= Number(fragments[j].power) || 1;
    return { count: touching.size, boost };
  });
}

/**
 * Join planned placements ({id, x, y, rotation}) to their definitions, giving
 * the shape/type/power every reader above needs. Unknown ids are dropped.
 * @param {{id: number, x: number, y: number, rotation: number}[]} placements @param {any[]} defs
 */
export function withDefs(placements, defs) {
  const byId = new Map((defs ?? []).map(d => [d.id, d]));
  return (placements ?? []).filter(p => byId.has(p.id)).map(p => ({ ...byId.get(p.id), ...p }));
}

/**
 * What a layout is worth under a priority table: the sum of weight x boost over
 * its stat fragments - the number planLayout maximises.
 * @param {{id: number, x: number, y: number, rotation: number}[]} placements
 * @param {any[]} defs @param {Record<string, number>} priorities
 */
export function layoutValue(placements, defs, priorities) {
  const placed = withDefs(placements, defs);
  const boosts = boostsOf(placed);
  return placed.reduce((sum, f, i) => sum + weightOf(f, priorities) * boosts[i].boost, 0);
}

/**
 * Everything wrong with a layout by the game's own placement rules
 * (StaneksGift.canPlace): out of the grid, overlapping, over a fragment's
 * limit, an unknown id - plus two roots coinciding, which the game allows but
 * its root-addressed API cannot work with. Empty when the layout is sound.
 * @param {{id: number, x: number, y: number, rotation: number}[]} placements
 * @param {any[]} defs @param {number} width @param {number} height
 * @returns {string[]}
 */
export function layoutProblems(placements, defs, width, height) {
  const byId = new Map((defs ?? []).map(d => [d.id, d]));
  const problems = [];
  const taken = new Map();
  const roots = new Set();
  const counts = new Map();
  for (const p of placements ?? []) {
    const def = byId.get(p.id);
    if (!def) { problems.push(`unknown fragment id ${p.id}`); continue; }
    if (![0, 1, 2, 3].includes(p.rotation)) problems.push(`fragment ${p.id}: rotation ${p.rotation}`);
    const w = rotatedWidth(def.shape, p.rotation);
    const h = rotatedHeight(def.shape, p.rotation);
    if (p.x < 0 || p.y < 0 || p.x + w > width || p.y + h > height) {
      problems.push(`fragment ${p.id} at ${p.x},${p.y} r${p.rotation} leaves the ${width}x${height} grid`);
    }
    const root = `${p.x},${p.y}`;
    if (roots.has(root)) problems.push(`two fragments share the root ${root}`);
    roots.add(root);
    counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
    if (counts.get(p.id) > def.limit) problems.push(`fragment ${p.id} placed more than its limit of ${def.limit}`);
    for (const [x, y] of cellsOf(p, def.shape)) {
      const key = `${x},${y}`;
      if (taken.has(key)) problems.push(`fragments ${taken.get(key)} and ${p.id} overlap at ${key}`);
      taken.set(key, p.id);
    }
  }
  return problems;
}

/** A canonical string for a set of placements - order-independent. */
export function layoutKey(placements) {
  return (placements ?? [])
    .map(p => `${p.id}@${p.x},${p.y}r${p.rotation}`)
    .sort()
    .join("|");
}

// ── The packer ───────────────────────────────────────────────────────────────

/** Defaults of the layout search; lib/config.js stanek.layout overrides the
 *  first four. The rest are the search's own tuning, measured over twelve seeds
 *  on nine grids (2x3 to 8x7) under both profiles: every grid up to 5x4 reaches
 *  the exhaustive optimum on every seed, and on the larger ones the worst seed
 *  is within 4% of the best - so none of them is worth a config knob. */
export const LAYOUT_DEFAULTS = {
  // Ruin-and-recreate rounds per restart, and restarts. The bound in the header.
  iterations: 300,
  restarts: 3,
  // Seed of the search's rng. Any integer; changing it changes the layout.
  seed: 13,
  // false packs stat fragments only.
  boosters: true,
  // `iterations` is the count for a catalog of referenceCatalog placements (an
  // 8x7 grid under a broad priority table); a shorter catalog gets up to
  // smallGridBoost times as many rounds for the same work (see planLayout).
  referenceCatalog: 2_200,
  smallGridBoost: 4,
  // A round removes one piece and up to (ruin - 1) of the pieces touching it.
  ruin: 3,
  // Random jitter on a candidate's score while rebuilding, as a fraction of the
  // top weight, fading to zero over a restart: what makes two rebuilds of the
  // same hole come out differently.
  noise: 0.3,
  // Worth of a placement hugging the walls and its neighbours, as a fraction of
  // the top weight. Only ever a tie-break between equal gains - it is what packs
  // the first pieces into a corner instead of the middle of an empty grid.
  pack: 0.15,
  // A rebuild that comes out slightly WORSE is still accepted with probability
  // exp(loss / temperature); the temperature starts at this fraction of the top
  // weight and falls to zero.
  temp: 0.02,
};

const EPS = 1e-9;

/** Seeded 32-bit rng (mulberry32): same seed, same layout, on every engine. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every way every candidate piece can sit on the grid: piece x distinct
 * orientation x root. An entry knows the cells it fills, the cells orthogonally
 * around it (as y * width + x indices) and how many of its edges lie on the
 * grid's border.
 */
function buildCatalog(pieces, width, height) {
  const catalog = [];
  pieces.forEach((piece, pieceIndex) => {
    for (const o of orientations(piece.shape)) {
      for (let y = 0; y + o.height <= height; y++) {
        for (let x = 0; x + o.width <= width; x++) {
          const cells = o.cells.map(([dx, dy]) => (y + dy) * width + (x + dx));
          const own = new Set(cells);
          const around = new Set();
          let walls = 0;
          for (const [dx, dy] of o.cells) {
            const cx = x + dx;
            const cy = y + dy;
            for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
              if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
                walls++;
                continue;
              }
              const n = ny * width + nx;
              if (!own.has(n)) around.add(n);
            }
          }
          catalog.push({
            pieceIndex,
            id: piece.id,
            booster: isBooster(piece),
            weight: piece.weight,
            power: Number(piece.power) || 1,
            limit: piece.limit,
            rotation: o.rotation,
            x,
            y,
            root: y * width + x,
            cells,
            around: [...around],
            walls,
          });
        }
      }
    }
  });
  return catalog;
}

/**
 * A mutable layout over a catalog: which entry owns each cell, which roots are
 * taken, which entries are on the board, how many of each piece. Every
 * operation is O(piece size).
 */
function makeBoard(catalog, pieceCount, cellCount) {
  const owner = new Int32Array(cellCount).fill(-1);
  const rootTaken = new Uint8Array(cellCount);
  const active = /** @type {number[]} */ ([]);
  const slot = new Int32Array(catalog.length).fill(-1);
  const counts = new Int32Array(pieceCount);

  function add(c) {
    const e = catalog[c];
    for (const cell of e.cells) owner[cell] = c;
    rootTaken[e.root] = 1;
    slot[c] = active.length;
    active.push(c);
    counts[e.pieceIndex]++;
  }
  function drop(c) {
    const e = catalog[c];
    for (const cell of e.cells) owner[cell] = -1;
    rootTaken[e.root] = 0;
    const at = slot[c];
    const last = /** @type {number} */ (active.pop());
    if (last !== c) {
      active[at] = last;
      slot[last] = at;
    }
    slot[c] = -1;
    counts[e.pieceIndex]--;
  }
  /** The game's canPlace, plus "no two fragments on one root" (see the header). */
  function fits(c) {
    const e = catalog[c];
    if (counts[e.pieceIndex] >= e.limit || rootTaken[e.root]) return false;
    for (const cell of e.cells) if (owner[cell] >= 0) return false;
    return true;
  }
  /** Product of the powers of the distinct boosters around a stat entry. */
  function boostOf(c) {
    let boost = 1;
    const seen = [];
    for (const cell of catalog[c].around) {
      const o = owner[cell];
      if (o < 0 || !catalog[o].booster || seen.includes(o)) continue;
      seen.push(o);
      boost *= catalog[o].power;
    }
    return boost;
  }
  /**
   * What entry `c` adds to (or, while it is on the board, contributes to) the
   * layout's value: a stat fragment its weight x boost, a booster 10% of the
   * boosted weight of every distinct stat fragment it touches.
   */
  function gainOf(c) {
    const e = catalog[c];
    if (!e.booster) return e.weight * boostOf(c);
    let gain = 0;
    const seen = [];
    for (const cell of e.around) {
      const o = owner[cell];
      if (o < 0 || o === c || catalog[o].booster || seen.includes(o)) continue;
      seen.push(o);
      const boost = boostOf(o);
      // On the board already, `boost` includes this booster: take it back out.
      gain += catalog[o].weight * (slot[c] >= 0 ? boost - boost / e.power : boost * (e.power - 1));
    }
    return gain;
  }
  /** Share of an entry's perimeter that is wall or already-placed piece. */
  function contact(c) {
    const e = catalog[c];
    let n = e.walls;
    for (const cell of e.around) if (owner[cell] >= 0) n++;
    return n / (e.walls + e.around.length);
  }
  /** The entries orthogonally touching entry `c`. */
  function touching(c) {
    const out = [];
    for (const cell of catalog[c].around) {
      const o = owner[cell];
      if (o >= 0 && !out.includes(o)) out.push(o);
    }
    return out;
  }
  /** sum(weight x boost) over the stat fragments on the board. */
  function value() {
    let sum = 0;
    for (const a of active) {
      if (!catalog[a].booster) sum += catalog[a].weight * boostOf(a);
    }
    return sum;
  }
  return { active, add, drop, fits, gainOf, contact, touching, value };
}

/**
 * Fill the board greedily: add the fitting placement with the best score until
 * none adds anything. Score = the value it adds, plus the packing tie-break,
 * plus jitter. A stat fragment (worth its weight) therefore goes down before
 * any booster (worth a tenth of what it touches), and each booster lands where
 * it touches the most weight.
 *
 * One pass over the catalog finds everything that fits now; later rounds only
 * re-check that list, since adding pieces can never make a placement START to
 * fit. A booster that touches nothing stays in the list - a later stat
 * fragment may give it a neighbour - but is never placed while its gain is 0.
 */
function recreate(catalog, board, rng, noise, pack) {
  let open = [];
  for (let c = 0; c < catalog.length; c++) if (board.fits(c)) open.push(c);
  for (;;) {
    let pick = -1;
    let best = -Infinity;
    const still = [];
    for (const c of open) {
      if (!board.fits(c)) continue;
      still.push(c);
      const gain = board.gainOf(c);
      if (gain <= EPS) continue;
      const score = gain + pack * board.contact(c) + (noise > 0 ? noise * rng() : 0);
      if (score > best) {
        best = score;
        pick = c;
      }
    }
    if (pick < 0) return;
    board.add(pick);
    open = still;
  }
}

/** Take off every booster that touches no stat fragment. */
function prune(catalog, board) {
  for (const c of board.active.slice()) {
    if (catalog[c].booster && board.gainOf(c) <= EPS) board.drop(c);
  }
}

/**
 * Lay the chosen fragments onto a width x height grid.
 *
 * Ruin and recreate (see the header for why, and for the bound): build a
 * layout greedily, then repeatedly tear out a piece and some of its neighbours
 * and rebuild the hole, keeping the result unless it is worse. The best layout
 * any restart visits wins; ties go to the earlier restart.
 *
 * Degrades by construction: a piece that does not fit the grid has no catalog
 * entries, a grid nothing fits returns no placements, and a table with no
 * positive weight returns no placements (boosters alone are worth nothing).
 *
 * @param {any[]} defs ns.stanek.fragmentDefinitions()
 * @param {number} width @param {number} height
 * @param {{priorities: Record<string, number>, iterations?: number, restarts?: number,
 *          seed?: number, boosters?: boolean}} opts
 * @returns {{placements: {id: number, x: number, y: number, rotation: number}[],
 *            value: number, cellsUsed: number, cells: number, stats: number, boosters: number}}
 */
export function planLayout(defs, width, height, opts) {
  const o = { ...LAYOUT_DEFAULTS, ...opts };
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const cellCount = w * h;
  const empty = { placements: [], value: 0, cellsUsed: 0, cells: cellCount, stats: 0, boosters: 0 };
  const chosen = chooseFragments(defs, o.priorities);
  if (cellCount === 0 || chosen.stats.length === 0) return empty;

  const pieces = [...chosen.stats, ...(o.boosters ? chosen.boosters : [])];
  const catalog = buildCatalog(pieces, w, h);
  if (!catalog.some(c => !c.booster)) return empty;

  const maxWeight = chosen.stats[0].weight;
  // A round costs one pass over the catalog, so a small grid (a short catalog)
  // gets proportionally more rounds for the same work - up to smallGridBoost
  // times. That is where they are needed: on a grid of twenty cells the optimum
  // is an exact tiling, and a greedy rebuild only stumbles on one now and then.
  const scale = Math.min(o.smallGridBoost, Math.max(1, o.referenceCatalog / catalog.length));
  const iterations = Math.max(0, Math.floor(o.iterations * scale));
  const restarts = Math.max(1, Math.floor(o.restarts));
  const pack = o.pack * maxWeight;

  let best = /** @type {number[]} */ ([]);
  let bestValue = -1;

  for (let r = 0; r < restarts; r++) {
    const rng = mulberry32((Math.imul(o.seed | 0, 2654435761) + r * 40503 + w * 31 + h) >>> 0);
    const board = makeBoard(catalog, pieces.length, cellCount);
    // The first restart starts from the plain greedy layout, the rest from
    // jittered ones, so the search never does worse than greedy.
    recreate(catalog, board, rng, r === 0 ? 0 : o.noise * maxWeight, pack);
    let current = board.value();
    let top = board.active.slice();
    let topValue = current;

    for (let i = 0; i < iterations && board.active.length > 0; i++) {
      const cooling = 1 - i / iterations;
      const saved = board.active.slice();

      // Ruin: one piece, and some of the pieces touching it.
      const first = board.active[Math.floor(rng() * board.active.length)];
      const victims = [first];
      const size = 1 + Math.floor(rng() * o.ruin);
      const near = board.touching(first);
      while (victims.length < size && near.length > 0) {
        victims.push(near.splice(Math.floor(rng() * near.length), 1)[0]);
      }
      for (const v of victims) board.drop(v);
      prune(catalog, board);

      recreate(catalog, board, rng, o.noise * maxWeight * cooling, pack);
      const next = board.value();
      const temperature = o.temp * maxWeight * cooling;
      if (next >= current || (temperature > 0 && rng() < Math.exp((next - current) / temperature))) {
        current = next;
        if (current > topValue + EPS) {
          topValue = current;
          top = board.active.slice();
        }
      } else {
        for (const c of board.active.slice()) board.drop(c);
        for (const c of saved) board.add(c);
      }
    }
    if (topValue > bestValue + EPS) {
      bestValue = topValue;
      best = top;
    }
  }

  // Belt and braces on the winner: no booster that touches nothing, and nothing
  // left out that would still fit and add value.
  const polished = makeBoard(catalog, pieces.length, cellCount);
  for (const c of best) polished.add(c);
  prune(catalog, polished);
  recreate(catalog, polished, () => 0, 0, 0);
  best = polished.active.slice();

  const placements = best
    .map(c => ({ id: catalog[c].id, x: catalog[c].x, y: catalog[c].y, rotation: catalog[c].rotation }))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id - b.id);
  const boosters = best.filter(c => catalog[c].booster).length;
  return {
    placements,
    value: polished.value(),
    cellsUsed: best.reduce((n, c) => n + catalog[c].cells.length, 0),
    cells: cellCount,
    stats: best.length - boosters,
    boosters,
  };
}

// ── When to (re)lay the gift ─────────────────────────────────────────────────

/**
 * Whether lib/stanek.js should replace what is on the gift with `planned`.
 *
 *   "apply" - the gift is empty, or it holds a different layout that has no
 *             charge to lose (a fresh node, or the moment after an aug install,
 *             which zeroes every charge and so makes re-laying free), or config
 *             explicitly allows discarding charge (relayoutCharged).
 *   "keep"  - it already is the planned layout; or mode is "keep" (a hand-made
 *             layout is the player's); or the plan is empty; or - the case this
 *             exists for - the layout differs but is CHARGED: re-placing a
 *             fragment resets its charge, so the new plan waits (`pending`) for
 *             the next install to make the switch free.
 *
 * @param {any[]} active ns.stanek.activeFragments()
 * @param {{id: number, x: number, y: number, rotation: number}[]} planned
 * @param {{mode?: string, relayoutCharged?: boolean}} [opts]
 * @returns {{action: "apply" | "keep", reason: string, pending: boolean}}
 */
export function layoutDecision(active, planned, opts = {}) {
  const have = active ?? [];
  const want = planned ?? [];
  if (want.length === 0) return { action: "keep", reason: "nothing fits this grid", pending: false };
  if (have.length === 0) return { action: "apply", reason: "the gift is empty", pending: false };
  if (layoutKey(have) === layoutKey(want)) return { action: "keep", reason: "already the planned layout", pending: false };
  if (opts.mode === "keep") return { action: "keep", reason: "layout.mode is keep", pending: false };
  const charged = have.some(f => (f.numCharge ?? 0) > 0 || (f.highestCharge ?? 0) > 0);
  if (charged && !opts.relayoutCharged) {
    return { action: "keep", reason: "the current layout is charged", pending: true };
  }
  return {
    action: "apply",
    reason: charged ? "relayoutCharged is set" : "the current layout has no charge to lose",
    pending: false,
  };
}

// ── Charging ─────────────────────────────────────────────────────────────────

/**
 * The game's CalculateEffect: the multiplier a fragment applies.
 * @param {number} highestCharge @param {number} numCharge @param {number} power
 * @param {number} boost @param {number} [nodeMult] StaneksGiftPowerMultiplier
 */
export function chargeEffect(highestCharge, numCharge, power, boost, nodeMult = 1) {
  return 1 + (Math.log(highestCharge + 1) / 60) * Math.pow((numCharge + 1) / 5, 0.07) * power * boost * nodeMult;
}

/**
 * The game's StaneksGift.charge: a fragment's charge state after one charge of
 * `threads` (already multiplied by the host's core bonus).
 * @param {{highestCharge: number, numCharge: number}} state @param {number} threads
 */
export function chargeAfter(state, threads) {
  const highestCharge = Number(state?.highestCharge) || 0;
  const numCharge = Number(state?.numCharge) || 0;
  if (!(threads > 0)) return { highestCharge, numCharge };
  if (threads > highestCharge) {
    return { highestCharge: threads, numCharge: (highestCharge * numCharge) / threads + 1 };
  }
  return { highestCharge, numCharge: numCharge + threads / highestCharge };
}

/** The part of the bonus that charging moves: ln(h + 1) x ((n + 1) / 5)^0.07. */
function chargeTerm(state) {
  return Math.log((Number(state.highestCharge) || 0) + 1) * Math.pow(((Number(state.numCharge) || 0) + 1) / 5, 0.07);
}

/**
 * Scheduling weights for what is actually ON the gift. A fragment the priority
 * table gives nothing (a hand-placed one, or a table edited after the layout
 * was made) still gets a tenth of the top weight: it is on the board, charging
 * is the only thing that makes it do anything, and one hit from the big worker
 * is nearly all of its value.
 */
function chargeWeights(active, priorities) {
  const raw = active.map(f => (isBooster(f) ? 0 : weightOf(f, priorities)));
  const top = Math.max(0, ...raw);
  const floor = top > 0 ? top * 0.1 : 1;
  return active.map((f, i) => (isBooster(f) ? 0 : Math.max(raw[i], floor)));
}

/**
 * Which fragment a charge of `threads` should go to next: the one whose
 * weighted bonus rises the most, by the game's own formulas.
 *
 *   gain = weight x boost x (term(after) - term(before))
 *
 * power and StaneksGiftPowerMultiplier are left out on purpose: the weight
 * already stands for the worth of the fragment's whole bonus (chooseFragments),
 * and the node multiplier scales every fragment alike. What falls out:
 *   - a fragment the charge would be a new BIGGEST for wins outright (ln(h + 1)
 *     jumps), so a newly enlarged worker visits every fragment once first;
 *   - after that, charges go where weight x boost / (count + 1)^0.93 is largest,
 *     i.e. roughly in proportion to weight x boost - a boosted, high-priority
 *     fragment is charged more often, but nothing starves.
 * Boosters are never returned (the game throws on charging one). Ties go to
 * the earlier fragment in `active`.
 *
 * @param {any[]} active ns.stanek.activeFragments() (or simulated states)
 * @param {number} threads @param {{priorities?: Record<string, number>}} [opts]
 * @returns {{index: number, id: number, x: number, y: number, gain: number} | null}
 */
export function nextCharge(active, threads, opts = {}) {
  const list = active ?? [];
  if (!(threads > 0) || list.length === 0) return null;
  const weights = chargeWeights(list, opts.priorities ?? {});
  const boosts = boostsOf(list);
  let pick = null;
  list.forEach((f, i) => {
    if (isBooster(f)) return;
    const gain = weights[i] * boosts[i].boost * (chargeTerm(chargeAfter(f, threads)) - chargeTerm(f));
    if (!pick || gain > pick.gain + 1e-12) pick = { index: i, id: f.id, x: f.x, y: f.y, gain };
  });
  return pick;
}

/**
 * The list the charge workers walk: every chargeable fragment once, then
 * `extra` more picks, each chosen by nextCharge against the state the picks
 * before it would leave. Returned FLAT - [x0, y0, x1, y1, ...] - because that is
 * what hacking/charge.js takes as arguments.
 *
 * "Every fragment once" is not a courtesy: highestCharge is per fragment, so
 * the largest worker has to reach each of them, and a list built from marginal
 * gain alone could leave a low-weight fragment out of a short rotation.
 *
 * @param {any[]} active @param {number} threads
 * @param {{priorities?: Record<string, number>, extra?: number}} [opts]
 * @returns {number[]}
 */
export function chargeRotation(active, threads, opts = {}) {
  const sim = (active ?? []).map(f => ({ ...f }));
  const chargeable = sim.filter(f => !isBooster(f)).length;
  if (chargeable === 0) return [];
  const t = threads > 0 ? threads : 1;
  const flat = [];
  const visited = new Set();
  const extra = Math.max(0, Math.floor(opts.extra ?? chargeable));
  for (let step = 0; step < chargeable + extra; step++) {
    // First lap: the best fragment not yet visited. Afterwards: the best of all.
    const pool = step < chargeable ? sim.map((f, i) => (visited.has(i) ? { ...f, type: BOOSTER } : f)) : sim;
    const pick = nextCharge(pool, t, opts);
    if (!pick) break;
    visited.add(pick.index);
    Object.assign(sim[pick.index], chargeAfter(sim[pick.index], t));
    flat.push(pick.x, pick.y);
  }
  return flat;
}

// ── RAM: which hosts the charge workers hold ─────────────────────────────────

/**
 * The share of the botnet the charge workers should hold right now.
 *
 * The bonus grows with the 0.07th power of the charge count: the first fifty
 * charges take a fragment from 0.89x to 1.18x of its "five charges" value, the
 * next five hundred only to 1.38x. So a gift that is FRESH - a new layout, or
 * the minutes after an aug install zeroed every charge - is worth a large slice
 * of RAM for a short while, and a charged one only the steady slice.
 *
 * @param {any[]} active ns.stanek.activeFragments()
 * @param {{ramFraction: number, freshFraction?: number, freshCharges?: number}} cfg
 * @returns {{fraction: number, fresh: boolean}} fraction 0 when nothing on the
 *          gift can be charged
 */
export function chargeFraction(active, cfg) {
  const chargeable = (active ?? []).filter(f => !isBooster(f));
  if (chargeable.length === 0) return { fraction: 0, fresh: false };
  const steady = Math.max(0, Math.min(1, Number(cfg.ramFraction) || 0));
  const least = Math.min(...chargeable.map(f => Number(f.numCharge) || 0));
  const fresh = least < (cfg.freshCharges ?? 0);
  const burst = Math.max(0, Math.min(1, Number(cfg.freshFraction) || 0));
  return { fraction: fresh ? Math.max(steady, burst) : steady, fresh };
}

/**
 * Split a RAM budget over hosts for the charge workers.
 *
 * The budget is `fraction` of everything usable, and it goes to the LARGEST
 * hosts first, whole, until it runs out (the last host taken may be partial).
 * Largest-first because a charge is worth ln(threads of the single biggest
 * process): half of the fleet as four full servers beats the same RAM as a
 * slice of every server. Home, when offered, is just another host, less its
 * reserve.
 *
 * @param {{host: string, max: number, reserve?: number}[]} hosts eligible hosts
 *        (rooted, not daemon-reserved); `reserve` GB of each are never planned
 * @param {{fraction: number, threadRam: number, maxHosts?: number, minThreads?: number,
 *          maxRam?: number}} opts
 * @returns {{host: string, threads: number, ram: number}[]} largest first
 */
export function planChargeHosts(hosts, opts) {
  const threadRam = opts.threadRam;
  if (!(threadRam > 0) || !(opts.fraction > 0)) return [];
  const minThreads = Math.max(1, Math.floor(opts.minThreads ?? 1));
  const usable = (hosts ?? [])
    .map(h => ({ host: h.host, ram: Math.max(0, h.max - (h.reserve ?? 0)) }))
    .filter(h => h.ram >= threadRam)
    // Name as the tie-break, so equal servers always come out in the same order
    // and the plan does not shuffle between ticks.
    .sort((a, b) => b.ram - a.ram || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  const total = usable.reduce((sum, h) => sum + h.ram, 0);
  let remaining = Math.min(Math.min(1, opts.fraction) * total, opts.maxRam ?? Infinity);
  const plan = [];
  for (const h of usable) {
    if (plan.length >= (opts.maxHosts ?? Infinity)) break;
    const threads = Math.floor(Math.min(h.ram, remaining) / threadRam);
    if (threads < minThreads) {
      // Too little left for this host. A smaller host further down could not
      // take more, so the plan is complete.
      break;
    }
    plan.push({ host: h.host, threads, ram: threads * threadRam });
    remaining -= threads * threadRam;
  }
  return plan;
}

/**
 * What to do about the charge workers on ONE host this tick.
 *
 * The aim is a single process of `want` threads. Getting there on a host the
 * batcher has filled takes a while (its legs must land), and killing them is
 * not on the table - an orphaned hack or grow leg corrupts its batch. So:
 *   "restart" - enough is free, together with what our own workers hold, to run
 *               the whole `want` as one process: kill ours, launch one. Also
 *               the answer when we hold MORE than want (the plan shrank).
 *   "topUp"   - not yet; take what is free now as an extra process (a smaller
 *               worker still adds to every fragment's count), provided the
 *               chunk is at least want / maxProcesses, which bounds how many
 *               processes a host collects before the consolidating restart.
 *   "stop"    - the host is no longer planned (want 0): kill ours.
 *   "none"    - on plan (within `tolerance`), or nothing useful fits yet.
 * A restart costs at most the one charge in flight: charge lives on the
 * fragment, not in the worker.
 *
 * @param {{want: number, have: number, processes: number, freeThreads: number}} host
 *        threads planned / threads our workers hold / how many processes that
 *        is / threads that fit in the host's free RAM right now
 * @param {{tolerance?: number, maxProcesses?: number, minThreads?: number}} [opts]
 * @returns {{action: "none" | "restart" | "topUp" | "stop", threads: number}}
 */
export function tendHost(host, opts = {}) {
  const tolerance = opts.tolerance ?? 0.1;
  const maxProcesses = Math.max(1, Math.floor(opts.maxProcesses ?? 4));
  const minThreads = Math.max(1, Math.floor(opts.minThreads ?? 1));
  const want = Math.max(0, Math.floor(host.want));
  const have = Math.max(0, Math.floor(host.have));
  const free = Math.max(0, Math.floor(host.freeThreads));

  if (want < minThreads) return have > 0 ? { action: "stop", threads: 0 } : { action: "none", threads: 0 };
  if (have > want * (1 + tolerance)) return { action: "restart", threads: want };
  const short = have < want * (1 - tolerance);
  if (!short && host.processes <= 1) return { action: "none", threads: 0 };
  if (have + free >= want) return { action: "restart", threads: want };
  if (!short) return { action: "none", threads: 0 };
  const chunk = Math.min(free, want - have);
  if (host.processes < maxProcesses && chunk >= Math.max(minThreads, Math.ceil(want / maxProcesses))) {
    return { action: "topUp", threads: chunk };
  }
  return { action: "none", threads: 0 };
}

/**
 * How many threads' worth of RAM the batcher should keep FREE on a host so the
 * plan there can complete - the other half of tendHost, evaluated on the state
 * its action leaves behind. Zero once a single process is on plan (within
 * tolerance): a worker that is close enough is not going to be restarted, so
 * asking for the difference would just idle that RAM for ever. Non-zero while
 * the host is short, or while several interim processes wait to be merged
 * (the merge needs `want - have` free to go ahead).
 * @param {{want: number, have: number, processes: number}} host
 * @param {{tolerance?: number, minThreads?: number}} [opts]
 */
export function holdThreads(host, opts = {}) {
  const tolerance = opts.tolerance ?? 0.1;
  const want = Math.max(0, Math.floor(host.want));
  const have = Math.max(0, Math.floor(host.have));
  if (want < Math.max(1, Math.floor(opts.minThreads ?? 1)) || have >= want) return 0;
  const short = have < want * (1 - tolerance);
  return short || host.processes > 1 ? want - have : 0;
}

// ── What the daemons read ────────────────────────────────────────────────────

/**
 * Where this BitNode stands on taking the gift, from the state lib/stanek.js
 * and early/stanek-boot.js publish (globalThis.gordStanekState):
 *
 *   "accepted" - the gift is installed. Augmentations and Bladeburner are free
 *                to go ahead.
 *   "refused"  - acceptGift was tried and the game said no (another
 *                augmentation is already owned or queued - permanent for this
 *                BitNode). Nothing left to wait for.
 *   "pending"  - nobody has asked yet IN THIS BITNODE. The daemon must not buy
 *                a non-NeuroFlux augmentation, graft one, or join the
 *                Bladeburner division (SF7.3 hands out The Blade's Simulacrum
 *                on joining) until this changes: canAcceptStaneksGift refuses
 *                anyone holding any augmentation but NeuroFlux Governor, and
 *                there is no second chance within the node.
 *
 * `resetAt` is ns.getResetInfo().lastNodeReset. It is the point of this
 * function: globalThis outlives a BitNode, so a state saying "accepted" may be
 * the LAST node's, and acting on it would spend the one chance. A state is
 * believed only when it carries this node's reset stamp. Its age does not
 * matter - within a node the answer cannot change back.
 *
 * @param {any} state globalThis.gordStanekState @param {number} resetAt
 * @returns {"accepted" | "refused" | "pending"}
 */
export function giftGate(state, resetAt) {
  if (!state || state.resetAt !== resetAt) return "pending";
  if (state.gate === "accepted" || state.gate === "refused") return state.gate;
  return "pending";
}

/**
 * giftGate for a node that may not want, or cannot have, the gift at all:
 * "off" when the node's config turns it off or the Stanek API is not available
 * (neither in BN13 nor holding Source-File 13), else the gate. This is the one
 * call the daemon and the cold-start driver make.
 * @param {any} resetInfo ns.getResetInfo() @param {any} stanekCfg forNode(n).stanek
 * @param {any} state globalThis.gordStanekState
 * @returns {"off" | "accepted" | "refused" | "pending"}
 */
export function giftStatus(resetInfo, stanekCfg, state) {
  if (!stanekCfg?.enabled || !hasApiAccess(resetInfo, [13])) return "off";
  return giftGate(state, resetInfo?.lastNodeReset);
}

/**
 * The per-host RAM (GB) the charge workers are still waiting for, from a LIVE
 * helper state - what hacking/manager.js should leave free on those hosts so
 * its landing legs are not replaced. Empty once the state is stale: a dead
 * helper must not keep RAM reserved for workers that will never start.
 * @param {any} state globalThis.gordStanekState @param {number} now @param {number} staleMs
 * @returns {Record<string, number>}
 */
export function chargeHolds(state, now, staleMs) {
  if (!state || !(now - (state.updatedAt ?? 0) <= staleMs)) return {};
  const out = /** @type {Record<string, number>} */ ({});
  for (const [host, gb] of Object.entries(state.holds ?? {})) {
    if (typeof gb === "number" && gb > 0) out[host] = gb;
  }
  return out;
}

/**
 * Fold the charge workers' holds into the botnet's per-host reservation map
 * (globalThis.gordReservedRam, read by hacking/manager.js reservedRamFor).
 * Takes the LARGER of what is there and the hold, not the sum: both are "keep
 * this much free", and free RAM that satisfies the bigger request satisfies the
 * smaller - which also makes this safe to apply twice.
 * @param {Record<string, number>} reservedRam mutated and returned
 * @param {Record<string, number>} holds
 */
export function mergeHolds(reservedRam, holds) {
  const out = reservedRam ?? {};
  for (const [host, gb] of Object.entries(holds ?? {})) {
    out[host] = Math.max(Number(out[host]) || 0, gb);
  }
  return out;
}
