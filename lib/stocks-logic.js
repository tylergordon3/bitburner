// lib/stocks-logic.js
//
// Pure decision logic for the stock trader (lib/stocks.js) - no Netscript calls
// at all, so it costs 0GB to import and can be unit-tested under plain Node
// (tests/stocks-logic.test.mjs, against tests/helpers/fake-market.mjs, which is a
// transcription of the game's market). Same split as lib/go.js / lib/go-logic.js.
//
// Everything here follows from how the game moves prices. From bitburner-src
// (branch dev, src/StockMarket/, read 2026-10-03):
//
//   - Each stock has a FORECAST p = P(price rises this tick) = (50 +- otlkMag)/100
//     and a max volatility mv. Every tick ONE uniform v is drawn for the whole
//     market, and each stock goes to price x (1 + v.mv) with probability p, else
//     price / (1 + v.mv). So the SIZE of a move says nothing about p (it is the
//     same draw for every stock) - only its DIRECTION does - and the expected
//     return of a tick is (2p - 1) x mv/2.
//   - p drifts slowly: by otlkMag x v.mv per tick (a percent or so of itself),
//     pulled towards a second-order forecast. Under otlkMag 5 the step is ten
//     times that, and under 1 it is a flat point per tick - a stock near 50%
//     wanders, a stock with a real outlook keeps it.
//   - Every 75 ticks (TicksPerCycle) each stock, independently and with
//     probability 0.45, has its forecast MIRRORED: p -> 1 - p. That is the only
//     way an outlook is lost quickly, and it only ever happens on those ticks.
//   - Buying and selling do not move the price. You pay the spread (buy at the
//     ask, sell at the bid; a short opens at the bid and closes at the ask) and a
//     flat commission per transaction, and a stock can be held up to maxShares,
//     long and short together.
//   - getForecast / getVolatility need the 4S Market Data TIX API. Without it the
//     only evidence of p is the sequence of ups and downs.
//
// The pieces:
//
//   ESTIMATOR   p for every stock without 4S data: a grid Bayes filter per
//               stock, run under every hypothesis about where the market cycle
//               is (newEstimator / observe / estimateOf / cycleInfo)
//   PLANNER     this tick's orders: exits, cash to raise, entries ranked by
//               expected return over the expected hold, replacements (planTrades)
//   4S          when the data API pays for itself (fourSPaybackTicks)
//   MANIPULATE  which servers the batcher should push up or down (influenceWishes)
//   TREASURY    BN8's spending allowance out of trading profit (allowanceStep)
//
// Naming note: Bitburner bills static RAM for any identifier that matches a
// Netscript function NAME, in any file a script imports (`x.hack`, `x.grow`,
// `x.share`, `re.exec` ... all cost RAM). This module stays at 0GB by not using
// those words - hence `up`/`down` rather than grow/hack in the wish list.

/** StockMarketConstants.TicksPerCycle. */
export const TICKS_PER_CYCLE = 75;
/** stockMarketCycle: chance that a stock's forecast is mirrored at a cycle. */
export const CYCLE_FLIP_CHANCE = 0.45;

// Stock symbol -> the server whose organizationName is that company
// (src/Server/data/servers.ts against src/StockMarket/Enums.ts StockSymbol).
// Hacking / growing THAT server with { stock: true } is what moves the stock's
// second-order forecast. Watchdog Security (WDS) has no server. Fulcrum also
// owns fulcrumassets, but it holds $1m, so it is no lever.
export const STOCK_SERVERS = {
  ECP: "ecorp", MGCP: "megacorp", BLD: "blade", CLRK: "clarkinc", OMTK: "omnitek",
  FSIG: "4sigma", KGI: "kuai-gong", FLCM: "fulcrumtech", STM: "stormtech",
  DCOMM: "defcomm", HLS: "helios", VITA: "vitalife", ICRS: "icarus",
  UNV: "univ-energy", AERO: "aerocorp", OMN: "omnia", SLRS: "solaris",
  GPH: "global-pharm", NVMD: "nova-med", LXO: "lexo-corp", RHOC: "rho-construction",
  APHE: "alpha-ent", SYSC: "syscore", CTK: "computek", NTLK: "netlink",
  OMGA: "omega-net", FNS: "foodnstuff", JGN: "joesguns", SGC: "sigma-cosmetics",
  CTYS: "catalyst", MDYN: "microdyne", TITN: "titan-labs",
};

// ── Estimator ────────────────────────────────────────────────────────────────
//
// The usual pre-4S approach counts up-ticks over a long window and compares it
// with a short window to notice an inversion. That throws away the one thing
// the source tells us for certain: an inversion can ONLY happen on a cycle
// tick, and between two cycle ticks p barely moves. A window that slides over
// a cycle tick averages two different stocks; a window that doesn't could have
// been four times as long.
//
// So this is the model run forwards instead - a hidden-Markov filter. For each
// stock we keep a belief over p on a grid; each tick it is
//   1. diffused a little (p's slow drift; faster near 50%, as in the game),
//   2. on a cycle tick, mixed with its own mirror image (55% as it was, 45%
//      flipped) - which is exactly what the game does to p,
//   3. multiplied by the likelihood of what the price just did (p if it rose,
//      1 - p if it fell) and renormalised.
// What comes out is a proper posterior: its mean is the forecast to trade on,
// its mass above 50% is how sure we are of the DIRECTION, and its spread is
// what 4S data would tell us that we don't know (the value-of-information the
// 4S payback rule uses).
//
// The catch is step 2 needs to know which tick is a cycle tick, and a script
// that has just started doesn't: the game seeds the countdown uniformly in
// 1..75 at every reset and exposes it nowhere. So the filter is run 75 times
// per stock, once per hypothesis "the cycle falls on ticks = phi mod 75", and
// each hypothesis is scored by how well it predicted every stock's moves (the
// right one explains ~15 of 33 stocks turning on the same tick; the wrong ones
// don't). The estimate is the weighted mixture, so there is no "detected / not
// detected" switch to get wrong: with flat weights it behaves like a filter
// with a small chance of inversion every tick, and it sharpens by itself as
// the weights concentrate - within a few cycles.
//
// Cost: 33 stocks x 75 hypotheses x 41 grid points, three passes - a few
// hundred thousand multiply-adds per market tick (every 4-6 seconds).

/**
 * @param {object} [o]
 * @param {number} [o.gridSize]    grid points for p in [0, 1] (odd, so 0.5 is one)
 * @param {number} [o.priorScale]  prior on |p - 0.5|: ~exp(-|p - 0.5| / priorScale).
 *        Starting forecasts are 50-69% (InitStockMetadata), so mass near 50%.
 * @param {number} [o.driftScale]  multiplier on the modelled drift of p. 1 is the
 *        game's own; raise it where something else is moving forecasts (stock
 *        manipulation by the batcher), so the belief forgets faster.
 * @param {number} [o.phaseMemory] per-tick decay of the cycle-phase evidence.
 *        Slightly under 1, so a phase that was right an hour ago but isn't now
 *        (a tick the script never saw) can be unseated.
 */
export function newEstimator(o = {}) {
  const K = (o.gridSize ?? 41) | 1;
  const P = TICKS_PER_CYCLE;
  const grid = new Float64Array(K);
  const prior = new Float64Array(K);
  const scale = o.priorScale ?? 0.12;
  let total = 0;
  for (let k = 0; k < K; k++) {
    grid[k] = k / (K - 1);
    prior[k] = Math.exp(-Math.abs(grid[k] - 0.5) / scale);
    total += prior[k];
  }
  for (let k = 0; k < K; k++) prior[k] /= total;

  // Likelihood of an up-tick at each grid point. Clipped off 0 and 1: otlkMag
  // tops out at 50, so p = 1 exists, but a likelihood of exactly 0 would let one
  // contrary tick (a price at its soft cap, say) annihilate a hypothesis.
  const likeUp = new Float64Array(K);
  for (let k = 0; k < K; k++) likeUp[k] = Math.min(0.995, Math.max(0.005, grid[k]));

  // The prior's own summary (mean, P(p > 0.5), E|2p-1|, E max(2p-1, 0)): what a
  // stock we have only just met is believed to be. Symmetric, so 0.5 / 0.5 -
  // "no idea", not "certainly falling", which is what an all-zero summary would
  // read as to an exit rule.
  const priorStats = [0, 0, 0, 0];
  for (let k = 0; k < K; k++) {
    const edge = 2 * grid[k] - 1;
    priorStats[0] += prior[k] * grid[k];
    priorStats[1] += edge > 0 ? prior[k] : edge < 0 ? 0 : prior[k] / 2;
    priorStats[2] += prior[k] * Math.abs(edge);
    priorStats[3] += prior[k] * Math.max(edge, 0);
  }

  return {
    K, P, grid, prior, likeUp, priorStats,
    driftScale: o.driftScale ?? 1,
    phaseMemory: o.phaseMemory ?? 0.998,
    ticks: 0,                         // market ticks observed so far
    logW: new Float64Array(P),        // log-evidence per cycle-phase hypothesis
    w: new Float64Array(P).fill(1 / P),
    stocks: /** @type {Map<string, any>} */ (new Map()),
    scratch: new Float64Array(K),
    tickEvidence: new Float64Array(P),
  };
}

function newStockState(est, price) {
  const { K, P, prior, priorStats } = est;
  const belief = new Float64Array(P * K);
  const stats = new Float64Array(P * 4);
  for (let h = 0; h < P; h++) {
    belief.set(prior, h * K);
    stats.set(priorStats, h * 4);
  }
  return {
    last: price,
    belief,
    diffuse: new Float64Array(K),     // per-grid-point diffusion coefficient
    diffuseAge: Infinity,
    stats,                            // per hypothesis: mean, P(p > 0.5), E|2p-1|, E max(2p-1, 0)
    moveSum: 0, moveCount: 0,         // mean |log return| - the pre-4S volatility
    seen: 0,                          // directional observations
    p: 0.5, up: 0.5, absEdge: 0, posEdge: 0,
  };
}

/**
 * The game's per-tick step of p, as a diffusion coefficient on the grid.
 * otlkMag steps by otlkMag x av (av = v x mv/100, v uniform), ten times that
 * under otlkMag 5, a flat point under 1. In units of p with m = |p - 0.5|:
 *   m <= 0.01: 0.01     m < 0.05: 10 m av     else: m av
 * and RMS av = mv/100/sqrt(3) = 2 x (mean |move|)/sqrt(3). A random step of size
 * s on a grid of spacing h is a diffusion of s^2 / (2 h^2) to each neighbour.
 */
function refreshDiffusion(est, st) {
  const { K, grid, driftScale } = est;
  const h = 1 / (K - 1);
  const meanMove = st.moveCount > 0 ? st.moveSum / st.moveCount : 0.005;
  const rmsAv = (2 * meanMove) / Math.sqrt(3);
  for (let k = 0; k < K; k++) {
    const m = Math.abs(grid[k] - 0.5);
    const step = (m <= 0.01 ? 0.01 : m < 0.05 ? 10 * m * rmsAv : m * rmsAv) * driftScale;
    st.diffuse[k] = Math.min(0.25, (step * step) / (2 * h * h));
  }
  st.diffuseAge = 0;
}

/**
 * Feed one market tick: the price of every stock, read once per ns.stock.nextUpdate().
 * Must be called exactly once per tick - the cycle phase is counted in calls.
 * @param {any} est - newEstimator()
 * @param {Iterable<[string, number]>} prices - [symbol, price] pairs
 */
export function observe(est, prices) {
  const { K, P, likeUp, scratch, tickEvidence } = est;
  est.ticks++;
  // The hypothesis whose cycle falls on THIS tick.
  const cyclePhase = est.ticks % P;
  const keep = 1 - CYCLE_FLIP_CHANCE;
  const half = (K - 1) / 2;
  tickEvidence.fill(0);

  for (const [sym, price] of prices) {
    let st = est.stocks.get(sym);
    if (!st) {
      est.stocks.set(sym, newStockState(est, price));
      continue; // a first price has no direction
    }
    const dir = price > st.last ? 1 : price < st.last ? -1 : 0;
    if (dir !== 0 && st.last > 0) {
      // Volatility without 4S: the mean size of a move. Capped memory, so a
      // changed volatility (the darknet can raise it) is picked up eventually.
      const move = Math.abs(Math.log(price / st.last));
      if (st.moveCount < 400) { st.moveSum += move; st.moveCount++; }
      else st.moveSum += move - st.moveSum / st.moveCount;
      st.seen++;
    }
    st.last = price;
    if (++st.diffuseAge > 16) refreshDiffusion(est, st);

    const { belief, diffuse, stats } = st;
    for (let h = 0; h < P; h++) {
      const off = h * K;
      // 1. Drift. Mass leaves k for each neighbour at diffuse[k]; at the ends
      //    the outward share stays put (p can't leave [0, 1]).
      for (let k = 0; k < K; k++) {
        const d = diffuse[k];
        let v = belief[off + k] * (1 - (k > 0 ? d : 0) - (k < K - 1 ? d : 0));
        if (k > 0) v += belief[off + k - 1] * diffuse[k - 1];
        if (k < K - 1) v += belief[off + k + 1] * diffuse[k + 1];
        scratch[k] = v;
      }
      // 2. The cycle, under the hypothesis that this is its tick.
      if (h === cyclePhase) {
        for (let k = 0; k < half; k++) {
          const a = scratch[k], b = scratch[K - 1 - k];
          scratch[k] = keep * a + CYCLE_FLIP_CHANCE * b;
          scratch[K - 1 - k] = keep * b + CYCLE_FLIP_CHANCE * a;
        }
      }
      // 3. The observation.
      let evidence = 1;
      if (dir !== 0) {
        evidence = 0;
        for (let k = 0; k < K; k++) {
          const v = scratch[k] * (dir > 0 ? likeUp[k] : 1 - likeUp[k]);
          scratch[k] = v;
          evidence += v;
        }
        tickEvidence[h] += Math.log(evidence);
      }
      // Renormalise, and take this hypothesis's summary while we are here.
      let mean = 0, up = 0, abs = 0, pos = 0;
      for (let k = 0; k < K; k++) {
        const v = scratch[k] / evidence;
        belief[off + k] = v;
        const edge = 2 * est.grid[k] - 1;
        mean += v * est.grid[k];
        if (edge > 0) { up += v; abs += v * edge; pos += v * edge; }
        else if (edge < 0) abs -= v * edge;
        else up += v / 2;
      }
      const s = h * 4;
      stats[s] = mean; stats[s + 1] = up; stats[s + 2] = abs; stats[s + 3] = pos;
    }
  }

  // Score the hypotheses on this tick's moves, all stocks together.
  let best = -Infinity;
  for (let h = 0; h < P; h++) {
    est.logW[h] = est.logW[h] * est.phaseMemory + tickEvidence[h];
    if (est.logW[h] > best) best = est.logW[h];
  }
  let total = 0;
  for (let h = 0; h < P; h++) {
    est.logW[h] -= best;
    est.w[h] = Math.exp(est.logW[h]);
    total += est.w[h];
  }
  for (let h = 0; h < P; h++) est.w[h] /= total;

  // Each stock's estimate: its hypotheses' summaries, mixed by those weights.
  for (const st of est.stocks.values()) {
    let p = 0, up = 0, abs = 0, pos = 0;
    for (let h = 0; h < P; h++) {
      const w = est.w[h], s = h * 4;
      p += w * st.stats[s]; up += w * st.stats[s + 1];
      abs += w * st.stats[s + 2]; pos += w * st.stats[s + 3];
    }
    st.p = p; st.up = up; st.absEdge = abs; st.posEdge = pos;
  }
}

/**
 * What the estimator believes about one stock.
 *   p        posterior mean forecast - the number to trade on
 *   up       P(forecast > 50%): how sure we are of the DIRECTION
 *   absEdge  E|2p - 1|: the edge we would have if we knew p (longs and shorts)
 *   posEdge  E max(2p - 1, 0): the same where only longs are possible
 *   move     mean |log return| per tick = mv/2: the expected size of a move
 *   seen     directional observations so far
 * @param {any} est @param {string} sym
 */
export function estimateOf(est, sym) {
  const st = est.stocks.get(sym);
  if (!st) return { p: 0.5, up: 0.5, absEdge: 0, posEdge: 0, move: 0, seen: 0 };
  return {
    p: st.p, up: st.up, absEdge: st.absEdge, posEdge: st.posEdge,
    move: st.moveCount > 0 ? st.moveSum / st.moveCount : 0,
    seen: st.seen,
  };
}

/**
 * Where the market cycle is, as far as the price history says.
 *   confidence   weight on the likeliest phase (1/75 = no idea, ~1 = certain)
 *   ticksToCycle expected ticks until the next cycle tick (1..75), weighted over
 *                the hypotheses - ~38 while the phase is unknown
 * @param {any} est
 */
export function cycleInfo(est) {
  const { P, w, ticks } = est;
  let best = 0, expected = 0;
  for (let h = 0; h < P; h++) {
    if (w[h] > w[best]) best = h;
    // Next tick index congruent to h: 1..P ticks away.
    expected += w[h] * ((((h - ticks - 1) % P) + P) % P + 1);
  }
  return { confidence: w[best], ticksToCycle: expected, phase: best };
}

// ── Returns and position values ──────────────────────────────────────────────

/**
 * Expected return of ONE tick on a long position: (2p - 1) x the expected size
 * of a move. With 4S data `move` is getVolatility() / 2 (the move is uniform on
 * 0..mv); without, the observed mean |log return|. A short earns the negative.
 * @param {number} p @param {number} move
 */
export function expectedReturn(p, move) {
  return (2 * p - 1) * move;
}

/**
 * What a position is worth if closed now, before commission. A long sells at
 * the bid. A short returns its stake plus (entry - ask) per share, i.e.
 * shares x (2 x avgShort - ask).
 * @param {{bid: number, ask: number, longShares: number, shortShares: number, shortAvg: number}} s
 */
export function positionValue(s) {
  return {
    long: s.longShares > 0 ? s.longShares * s.bid : 0,
    short: s.shortShares > 0 ? s.shortShares * (2 * s.shortAvg - s.ask) : 0,
  };
}

/**
 * Cash plus what every position would fetch if closed now, commissions paid.
 * @param {{bid: number, ask: number, longShares: number, shortShares: number, shortAvg: number}[]} stocks
 * @param {number} cash @param {number} commission
 */
export function portfolioWorth(stocks, cash, commission) {
  let total = cash;
  for (const s of stocks) {
    const value = positionValue(s);
    if (value.long > 0) total += value.long - commission;
    if (value.short > 0) total += value.short - commission;
  }
  return total;
}

// ── Planner ──────────────────────────────────────────────────────────────────
//
// Sizing is "everything, in the best things": per-tick variance is tiny next to
// the edge (the Kelly fraction for a 60% stock moving 1% a tick is ~30x
// leverage), so the only reasons not to be fully invested are the ones below.
//
//   COSTS     Entering costs the spread twice over (in and, eventually, out)
//             and two commissions. An entry must earn `entryCostMult` times that
//             over its expected hold: the ticks left before the next cycle, plus
//             `holdTicksAfterCycle` (a cycle keeps the forecast 55% of the time
//             for another 75 ticks, and costs a few losing ticks the other 45%).
//   CERTAINTY Without 4S an estimate is only traded when the direction is
//             likely enough (`entryConfidence`, stricter for shorts), and held
//             until it is likely WRONG (`exitConfidence`): one down-tick after a
//             cycle should not sell a stock that is 55% likely unchanged, since
//             buying it back costs the spread again.
//   CAPS      maxShares (long + short together), and `maxPositionRatio` of net
//             worth per stock - protection against the estimate, not the market.
//   CASH      Two different kinds stay out of the market. `reserve` (a share of
//             net worth) is only ever not spent. `hold` - an invite hoard
//             (gordMoneyFloor), what the daemon has asked for, the 4S price -
//             has to BE there, so the WORST positions are sold to raise it.
//
// A held position is ranked by what it will earn; a new one by that MINUS its
// entry cost. So something already owned is only swapped out for something
// better by more than the cost of the swap - the hysteresis that stops the
// portfolio churning between two similar stocks.

/**
 * @typedef {object} StockView
 * @property {string} sym
 * @property {number} price @property {number} ask @property {number} bid
 * @property {number} maxShares
 * @property {number} longShares @property {number} shortShares
 * @property {number} shortAvg  average entry price of the short
 * @property {number} p     forecast (4S, or the estimator's mean)
 * @property {number} up    P(forecast > 0.5): 1 or 0 with 4S data
 * @property {number} move  expected |return| per tick
 * @property {number} seen  directional observations behind the estimate
 */

/**
 * @typedef {object} Order
 * @property {"sell" | "cover" | "buy" | "short"} action
 * @property {string} sym @property {number} shares @property {string} why
 */

/**
 * One tick's orders. Pure: reads the views, returns orders (exits first) and a
 * summary; lib/stocks.js executes them.
 *
 * @param {StockView[]} stocks
 * @param {object} a
 * @param {number} a.cash
 * @param {number} a.reserve      cash we won't BUY below (the reserve ratio's share
 *        of net worth). Never sold for: net worth moves every tick, and topping a
 *        ratio back up would sell a sliver of something each time it did.
 * @param {number} a.hold         cash that must BE there - an invite hoard, the
 *        daemon's allowance, the 4S price. Positions are sold to reach it.
 * @param {boolean} a.canShort
 * @param {boolean} a.exact       forecasts are 4S data, not estimates
 * @param {number} a.ticksToCycle expected ticks to the next cycle tick
 * @param {boolean} [a.liquidate] sell everything, buy nothing (install pending)
 * @param {any} cfg - the node's CONFIG.stocks (forNode)
 */
export function planTrades(stocks, a, cfg) {
  const commission = cfg.commission;
  /** @type {Order[]} */
  const orders = [];

  // ── What we hold, and what it is all worth ────────────────────────────────
  const rows = stocks.map(s => {
    const value = positionValue(s);
    return {
      s,
      longValue: value.long,
      shortValue: value.short,
      // Round-trip cost as a fraction of the position: the spread in and out.
      spread: s.price > 0 ? (s.ask - s.bid) / s.price : 0,
      edge: expectedReturn(s.p, s.move),   // per tick, for a long
      outLong: 0, outShort: 0,             // shares queued for sale this tick
    };
  });
  const netWorth = portfolioWorth(stocks, a.cash, commission);
  // Cash kept out of the market when buying; `a.hold` alone is what we sell for.
  const liquid = Math.max(a.reserve ?? 0, a.hold ?? 0);

  const summary = {
    netWorth,
    invested: netWorth - a.cash,
    expectedIncome: 0,     // $ per tick the portfolio AFTER these orders expects
    idleCash: 0,           // cash above `liquid` that found nothing to buy
  };

  let cash = a.cash;
  const sell = (r, side, shares, why) => {
    shares = Math.min(shares, side === "long" ? r.s.longShares - r.outLong : r.s.shortShares - r.outShort);
    if (!(shares > 0)) return 0;
    const unit = side === "long" ? r.s.bid : 2 * r.s.shortAvg - r.s.ask;
    const proceeds = shares * unit - commission;
    if (side === "long") r.outLong += shares; else r.outShort += shares;
    orders.push({ action: side === "long" ? "sell" : "cover", sym: r.s.sym, shares, why });
    cash += proceeds;
    return proceeds;
  };

  if (a.liquidate) {
    for (const r of rows) {
      sell(r, "long", r.s.longShares, "liquidate");
      sell(r, "short", r.s.shortShares, "liquidate");
    }
    return { orders, summary };
  }

  // ── 1. Exits: the forecast has turned against the position ───────────────
  // With 4S data that is a fact (the configured thresholds, 50% by default).
  // Without it, it is a probability, and we wait until the direction is more
  // likely wrong than `exitConfidence` allows.
  for (const r of rows) {
    const { s } = r;
    const longWrong = a.exact ? s.p < cfg.sellThreshold : s.up < cfg.exitConfidence;
    const shortWrong = a.exact ? s.p > cfg.coverThreshold : s.up > 1 - cfg.exitConfidence;
    if (s.longShares > 0 && longWrong) sell(r, "long", s.longShares, "forecast turned");
    if (s.shortShares > 0 && (shortWrong || !a.canShort)) sell(r, "short", s.shortShares, "forecast turned");
  }

  // ── 2. Rank what we hold and what we could buy ───────────────────────────
  const horizon = Math.max(1, a.ticksToCycle) + cfg.holdTicksAfterCycle;
  const perStockCap = cfg.maxPositionRatio * netWorth;

  /** Held positions that survived the exits, worst first when we need cash. */
  const held = [];
  /** Things worth buying (more of), best first. */
  const wanted = [];
  for (const r of rows) {
    const { s } = r;
    const longLeft = s.longShares - r.outLong;
    const shortLeft = s.shortShares - r.outShort;
    if (longLeft > 0) held.push({ r, side: "long", score: r.edge * horizon });
    if (shortLeft > 0) held.push({ r, side: "short", score: -r.edge * horizon });

    // One side per stock: the one the forecast favours.
    const side = r.edge > 0 ? "long" : "short";
    const edge = Math.abs(r.edge);
    if (!(edge > 0) || !(s.price > 0)) continue;
    if (side === "short" && !a.canShort) continue;
    // Never both sides of one stock, and not the side we are just leaving.
    if (side === "long" ? (shortLeft > 0 || r.outLong > 0) : (longLeft > 0 || r.outShort > 0)) continue;

    const sure = a.exact
      ? (side === "long" ? s.p >= cfg.buyThreshold : s.p <= cfg.shortThreshold)
      : (s.seen >= cfg.minObservations &&
         (side === "long" ? s.up >= cfg.entryConfidence : 1 - s.up >= cfg.entryConfidenceShort));
    if (!sure) continue;

    // Expected gain over the hold, net of the entry's costs, per dollar.
    const net = edge * horizon - cfg.entryCostMult * r.spread;
    if (!(net > 0)) continue;
    wanted.push({ r, side, edge, net });
  }
  wanted.sort((x, y) => y.net - x.net);
  held.sort((x, y) => x.score - y.score);

  const heldValue = h => {
    const left = h.side === "long" ? h.r.s.longShares - h.r.outLong : h.r.s.shortShares - h.r.outShort;
    return left * (h.side === "long" ? h.r.s.bid : 2 * h.r.s.shortAvg - h.r.s.ask);
  };

  // ── 3. Raise cash if we are short of what must be there ──────────────────
  for (const h of held) {
    const need = (a.hold ?? 0) - cash;
    if (!(need > 0)) break;
    const unit = h.side === "long" ? h.r.s.bid : 2 * h.r.s.shortAvg - h.r.s.ask;
    const left = h.side === "long" ? h.r.s.longShares - h.r.outLong : h.r.s.shortShares - h.r.outShort;
    if (!(unit > 0) || !(left > 0)) continue;
    let shares = Math.ceil((need + commission) / unit);
    // Don't leave a stub too small to be worth its own commission later.
    if ((left - shares) * unit < cfg.minBuyCommissionMult * commission) shares = left;
    sell(h.r, h.side, shares, "raise cash");
  }

  // ── 4. Buy, best first; swap out something worse when cash runs out ──────
  // `room` is how much more of a stock we may hold: the share cap (both sides
  // count) and the per-stock share of net worth.
  const roomFor = c => {
    const { s } = c.r;
    const unit = c.side === "long" ? s.ask : s.bid;
    const have = c.side === "long" ? s.longShares : s.shortShares;
    const shareRoom = s.maxShares - s.longShares - s.shortShares;
    const valueRoom = (perStockCap - have * s.price) / unit;
    return { unit, shares: Math.max(0, Math.floor(Math.min(shareRoom, valueRoom))) };
  };
  // An order has to be big enough to earn its commissions back - in and out,
  // times minProfitCommissionMult - within commissionPaybackTicks at its edge,
  // and never smaller than the configured floor. This is also what stops a
  // growing portfolio from topping a position up by a sliver every tick at
  // $100k a time: the cash waits until it is an order worth placing.
  const minOrderValue = c => Math.max(
    cfg.minBuyCommissionMult * commission,
    (cfg.minProfitCommissionMult * commission) / (c.edge * cfg.commissionPaybackTicks),
  );

  // Exact forecasts need less of a margin than estimates do: with 4S the only
  // thing a swap can get wrong is the cost, and `net` already carries that.
  const replaceMargin = a.exact ? cfg.replaceMarginExact : cfg.replaceMargin;
  const sold = new Set();
  for (const c of wanted) {
    const room = roomFor(c);
    if (room.shares <= 0) continue;

    // Not enough cash to fill it? Replace the worst holdings, as long as this
    // is better than them by more than `replaceMargin` (net of entry cost on
    // one side, nothing on the other - the hysteresis).
    for (const h of held) {
      if (cash - liquid - commission >= room.shares * room.unit) break;
      if (sold.has(h) || h.r === c.r) continue;
      if (!(heldValue(h) > 0)) continue;
      if (!(c.net > h.score + replaceMargin)) break; // held is sorted worst first
      sold.add(h);
      sell(h.r, h.side, Infinity, `replaced by ${c.r.s.sym}`);
    }

    const spendable = cash - liquid - commission;
    const shares = Math.min(room.shares, Math.floor(spendable / room.unit));
    if (shares <= 0 || shares * room.unit < minOrderValue(c)) continue;
    orders.push({ action: c.side === "long" ? "buy" : "short", sym: c.r.s.sym, shares, why: "entry" });
    cash -= shares * room.unit + commission;
    c.bought = shares;
  }

  // ── Summary: what the book expects to earn, and what is left idle ────────
  for (const r of rows) {
    const longLeft = r.s.longShares - r.outLong;
    const shortLeft = r.s.shortShares - r.outShort;
    summary.expectedIncome += (longLeft - shortLeft) * r.s.price * r.edge;
  }
  for (const c of wanted) {
    if (c.bought) summary.expectedIncome += c.bought * c.r.s.price * c.edge;
  }
  summary.idleCash = Math.max(0, cash - liquid);

  // One order per stock and action (a position can be sold in two steps above -
  // some to raise cash, the rest to a replacement - and each order costs a
  // commission), and sells before buys, so the proceeds are there to spend.
  const merged = [];
  for (const o of orders) {
    const same = merged.find(x => x.sym === o.sym && x.action === o.action);
    if (same) same.shares += o.shares;
    else merged.push(o);
  }
  merged.sort((x, y) => orderRank(x) - orderRank(y));
  return { orders: merged, summary };
}

function orderRank(o) {
  return o.action === "sell" || o.action === "cover" ? 0 : 1;
}

// ── 4S Market Data TIX API: when it pays for itself ──────────────────────────
//
// In BN8 the $25b for the API comes out of the capital that is compounding, so
// "a share of cash" is the wrong test. The right one is a payback: with the API
// we are poorer by its cost but earn at a better rate; how long until that
// poorer-but-sharper portfolio has caught up with the one we have?
//
// The better rate isn't a guess. The estimator's posterior says how much edge
// we have (|2 E[p] - 1|: we trade on the mean) and how much we would have if we
// KNEW p (E|2p - 1|) - the difference is exactly what the data is worth, stock
// by stock, right now. tradingRate() turns either into a return on capital by
// filling the best stocks first up to their share caps, so the comparison also
// knows that a big portfolio has to reach further down the list.

/**
 * Expected return per tick, per dollar, of `wealth` spread over the best of
 * `items` (each {edge: expected return per tick, cap: $ that fit in the stock}).
 * @param {number} wealth @param {{edge: number, cap: number}[]} items
 */
export function tradingRate(wealth, items) {
  if (!(wealth > 0)) return 0;
  let left = wealth, income = 0;
  for (const it of [...items].sort((x, y) => y.edge - x.edge)) {
    if (!(left > 0) || !(it.edge > 0)) break;
    const put = Math.min(left, it.cap);
    income += put * it.edge;
    left -= put;
  }
  return income / wealth;
}

/**
 * Market ticks until a portfolio that paid `cost` and earns `rateWith` per tick
 * has caught up with one that kept the money and earns `rateWithout`:
 *   (wealth - cost) (1 + rateWith)^T = wealth (1 + rateWithout)^T
 * Infinity when it never does (can't afford it, or the data adds nothing).
 * @param {number} wealth @param {number} cost
 * @param {number} rateWithout @param {number} rateWith  per tick, compounding
 */
export function fourSPaybackTicks(wealth, cost, rateWithout, rateWith) {
  if (!(wealth > cost) || !(cost >= 0)) return Infinity;
  const gain = Math.log1p(rateWith) - Math.log1p(rateWithout);
  if (!(gain > 0)) return Infinity;
  return Math.log(wealth / (wealth - cost)) / gain;
}

/**
 * The moment to buy: when what is left after paying EARNS more per tick than
 * the whole does now, (wealth - cost) x rateWith >= wealth x rateWithout.
 *
 * That is not a second rule beside the payback - it is where the payback rule's
 * best threshold sits. Buying at wealth W and compounding to a far horizon
 * leaves ln(W - cost) + rateWith x (time left); waiting a tick first is worth
 * rateWithout x W / (W - cost) against the rateWith it gives up, so waiting
 * stops paying exactly at W / (W - cost) = rateWith / rateWithout. Earlier, the
 * capital still compounds faster whole than the data would make the remainder;
 * later, every tick of delay is a tick at the worse rate. At that point the
 * payback is ln(rateWith / rateWithout) / (rateWith - rateWithout) - about one
 * e-folding time of the capital (an hour, on the measured rates), however big
 * the price.
 * @param {number} wealth @param {number} cost
 * @param {number} rateWithout @param {number} rateWith
 */
export function fourSWorthIt(wealth, cost, rateWithout, rateWith) {
  if (!(wealth > cost)) return false;
  return (wealth - cost) * rateWith >= wealth * rateWithout && rateWith > rateWithout;
}

// ── Stock manipulation: what to ask of the batcher ───────────────────────────
//
// A hack() or grow() carrying { stock: true } moves the SECOND-ORDER forecast of
// the target server's company: a grow that restores a fraction f of the
// server's max money raises it by 0.1 with probability f, a hack that takes f
// lowers it by 0.1 with probability f (PlayerInfluencing.ts). The forecast then
// walks towards it with up to 95% of its steps. A batcher cycling a server
// through half its money once a second moves it ~0.3 a tick, against a natural
// wander of a few hundredths - so a stock whose server the botnet can work is a
// stock whose direction we choose, and at otlkMag 50 it rises (or falls) EVERY
// tick. Nothing else in the market is worth as much.
//
// An ordinary HGW batch does both and cancels itself out, so the wish is one-
// sided: for a stock we are long (or want up), flag the GROWS and not the hacks;
// for one we are short, flag the HACKS and not the grows. Always in the
// direction of the position we hold - a mirrored forecast is traded, not fought:
// pushing it back takes longer than the cycle that will mirror it again.

/**
 * @param {{sym: string, longValue: number, shortValue: number, p: number, up: number, move: number}[]} stocks
 * @param {{canShort: boolean}} a
 * @param {any} cfg - CONFIG.stocks.manipulation
 * @returns {{up: string[], down: string[]}} server hostnames, most valuable first:
 *   `up` - grows should carry { stock: true } (and hacks must not);
 *   `down` - hacks should carry it (and grows must not).
 */
export function influenceWishes(stocks, a, cfg) {
  const up = [], down = [];
  if (!cfg?.enabled) return { up: [], down: [] };
  for (const s of stocks) {
    const host = STOCK_SERVERS[s.sym];
    if (!host) continue;
    // What we hold decides; ranked by what a full swing of the forecast is
    // worth there (position value x the size of its moves).
    if (s.longValue > 0 || s.shortValue > 0) {
      const long = s.longValue >= s.shortValue;
      (long ? up : down).push({ host, weight: 1e6 + Math.max(s.longValue, s.shortValue) * s.move });
      continue;
    }
    // Not held: with `pump` on (BN8), list it anyway so the batcher can CREATE
    // the edge - towards the side the estimate already leans, and up when it
    // leans nowhere (a long has no ceiling; a short tops out at its stake).
    if (!cfg.pump) continue;
    const short = a.canShort && s.up <= cfg.pumpDownBelow;
    (short ? down : up).push({ host, weight: s.move });
  }
  const hosts = list => list.sort((x, y) => y.weight - x.weight).map(x => x.host);
  return { up: hosts(up), down: hosts(down) };
}

// ── Treasury (BN8): how much of the capital may be spent ─────────────────────
//
// In BN8 the trader's capital IS the player's money, and every other spender in
// the repo (augs and donations, purchased servers, home RAM, sleeve augs,
// grafts) budgets against the cash it can see. So the brake on spending is
// simply how much cash the trader leaves visible: it keeps `wanted` liquid and
// invests the rest, and those spenders' own fraction-of-cash rules then act on
// the allowance as if it were the whole treasury.
//
// The allowance is a DIVIDEND, not a share of net worth: a fixed share of cash
// would refill the moment it was spent, and a spender with an appetite (25
// servers, each doubling) would drain the capital at its own pace. Instead a
// bucket fills with `payout` of every new HIGH in gross wealth (net worth plus
// everything spent so far - so a purchase doesn't read as a loss, and a
// drawdown has to be earned back before any more is paid out) and empties as
// money is spent. The capital compounds at (1 - payout) of its rate whatever the
// spenders do.

/**
 * @param {{bucket: number, highWater: number, lastOutflow: number} | null} prev
 * @param {object} o
 * @param {number} o.netWorth   cash + positions (the trader's figure)
 * @param {number} o.outflow    cumulative cash spent by everything but the trader
 * @param {boolean} o.has4S
 * @param {number} o.idleCash   cash the trader has had no use for, for a while
 * @param {any} cfg - CONFIG.stocks.treasury
 * @returns {{bucket: number, highWater: number, lastOutflow: number, wanted: number}}
 */
export function allowanceStep(prev, o, cfg) {
  const gross = o.netWorth + o.outflow;
  if (!prev) {
    // The opening grant: TOR, the port openers, the first home RAM - the things
    // that cost a few percent of $250m and are worth far more than they would
    // have earned.
    const bucket = cfg.startFraction * o.netWorth;
    return { bucket, highWater: gross, lastOutflow: o.outflow, wanted: bucket };
  }
  const payout = o.has4S ? cfg.payout : cfg.payoutPre4S;
  let bucket = prev.bucket - (o.outflow - prev.lastOutflow);
  if (gross > prev.highWater) bucket += payout * (gross - prev.highWater);
  // Never hold more than this idle: an allowance nobody is spending is capital
  // that isn't compounding.
  bucket = Math.min(bucket, cfg.capFraction * o.netWorth);
  // Cash the trader can't place (every worthwhile stock at its share cap) costs
  // nothing to spend.
  const wanted = Math.max(0, bucket, o.idleCash);
  return { bucket, highWater: Math.max(prev.highWater, gross), lastOutflow: o.outflow, wanted };
}
