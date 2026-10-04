// tests/helpers/fake-market.mjs
//
// A fake World Stock Exchange for driving lib/stocks.js and lib/stocks-logic.js
// under Node. It is a TRANSCRIPTION of the game's own model, not an
// approximation of it - the estimator and the trading rules were designed from
// these exact rules, so the tests would prove nothing against a friendlier
// market. Read from bitburner-src (branch dev) on 2026-10-03:
//
//   src/StockMarket/data/InitStockMetadata.ts  the 33 stocks' starting ranges
//   src/StockMarket/Stock.ts                   cycleForecast, cycleForecastForecast,
//                                              flipForecastForecast, bid/ask,
//                                              influenceForecast(+Forecast), maxShares
//   src/StockMarket/StockMarket.ts             processStockPrices, stockMarketCycle
//   src/StockMarket/StockMarketHelpers.ts      transaction cost/gain, and what a
//                                              transaction does to the forecast
//   src/StockMarket/BuyingAndSelling.tsx       the four transactions
//   src/StockMarket/PlayerInfluencing.ts       hack/grow -> second-order forecast
//   src/NetscriptFunctions/StockMarket.ts      what each ns.stock call needs
//
// The model, in the game's own variable names:
//
//   b, otlkMag       the forecast: P(price rises this tick) = (50 +- otlkMag)/100
//   otlkMagForecast  where the forecast is HEADED, on an absolute 0-100 scale.
//                    Each tick the forecast steps by otlkMag x av towards it
//                    with probability (50 + clamp(otlkMagForecast - forecast,
//                    +-45))/100, and away otherwise. Below otlkMag 5 the step
//                    is ten times that; at or below 1 it is a flat 1 point.
//   mv               max volatility (%). ONE uniform v is drawn per tick and
//                    shared by every stock: av = v x mv / 100, and the price
//                    goes to price x (1 + av) or price / (1 + av).
//   cycle            every TicksPerCycle (75) ticks each stock, independently
//                    and with probability 0.45, has its forecast MIRRORED
//                    (b flips) together with its second-order forecast
//                    (100 - otlkMagForecast). The first cycle after a reset
//                    comes after a uniform 1..75 ticks.
//   spread           you buy at price x (1 + spreadPerc/100), sell at
//                    price x (1 - spreadPerc/100). A short is OPENED at the bid
//                    and closed at the ask.
//   commission       $100k per transaction, either direction.
//   maxShares        20% of (market cap / starting price), long + short together.
//   transactions     do NOT move the price. Every shareTxForMovement shares
//                    traded shave 0.006 off otlkMag (never below 5) and nudge
//                    otlkMagForecast towards 50 by 0.006 x mv/100.
//   hack / grow      with { stock: true } only: a successful hack lowers
//                    otlkMagForecast by 0.1 with probability moneyHacked/moneyMax;
//                    a grow raises it by 0.1 with probability moneyGrown/moneyMax.
//
// Not modelled: limit/stop orders (the trader does not place any - see
// lib/stocks.js), company work's tiny influence (0.001 per roll), and the
// darknet's volatility promotions (a multiplier on mv; getVolatility reports the
// multiplied figure, so the trader would simply see a more volatile stock).

/** The game's StockMarketConstants (src/StockMarket/data/Constants.ts). */
export const MARKET = {
  msPerStockUpdate: 6e3,
  msPerStockUpdateMin: 4e3,
  TicksPerCycle: 75,
  WseAccountCost: 200e6,
  TixApiCost: 5e9,
  MarketData4SCost: 1e9,
  MarketDataTixApi4SCost: 25e9,
  StockMarketCommission: 100e3,
};

/** stockMarketCycle: each stock's chance of being mirrored at a cycle. */
export const CYCLE_FLIP_CHANCE = 0.45;
/** StockForecastInfluenceLimit: transactions never push otlkMag below this. */
const FORECAST_INFLUENCE_LIMIT = 5;
/** forecastChangePerPriceMovement. */
const FORECAST_CHANGE_PER_MOVEMENT = 0.006;
/** forecastForecastChangeFromHack. */
const FF_CHANGE_FROM_HACK = 0.1;

// InitStockMetadata, one row per stock. price / mv / spread / shareTx are the
// [min, max] of a uniform INTEGER draw; mv is then divided by 100 (-> percent)
// and spread by 10 (-> percent), exactly as the `divisor` fields do in the game.
// `host` is the server whose organizationName is this stock's company
// (src/Server/data/servers.ts) - the one hack/grow influence reaches. Watchdog
// Security has no server.
export const STOCK_METADATA = [
  { sym: "ECP",   host: "ecorp",            b: true,  otlkMag: 19,   price: [17e3, 28e3],  marketCap: 2.4e12, mv: [40, 50],   spread: [1, 5],  shareTx: [30e3, 90e3] },
  { sym: "MGCP",  host: "megacorp",         b: true,  otlkMag: 19,   price: [24e3, 34e3],  marketCap: 2.4e12, mv: [40, 50],   spread: [1, 5],  shareTx: [30e3, 90e3] },
  { sym: "BLD",   host: "blade",            b: true,  otlkMag: 13,   price: [12e3, 25e3],  marketCap: 1.6e12, mv: [70, 80],   spread: [1, 6],  shareTx: [30e3, 90e3] },
  { sym: "CLRK",  host: "clarkinc",         b: true,  otlkMag: 12,   price: [10e3, 25e3],  marketCap: 1.5e12, mv: [65, 75],   spread: [1, 5],  shareTx: [30e3, 90e3] },
  { sym: "OMTK",  host: "omnitek",          b: true,  otlkMag: 12,   price: [32e3, 43e3],  marketCap: 1.8e12, mv: [60, 70],   spread: [1, 6],  shareTx: [30e3, 90e3] },
  { sym: "FSIG",  host: "4sigma",           b: true,  otlkMag: 17,   price: [50e3, 80e3],  marketCap: 2e12,   mv: [100, 110], spread: [1, 10], shareTx: [30e3, 90e3] },
  { sym: "KGI",   host: "kuai-gong",        b: true,  otlkMag: 10,   price: [16e3, 28e3],  marketCap: 1.9e12, mv: [75, 85],   spread: [1, 7],  shareTx: [30e3, 90e3] },
  { sym: "FLCM",  host: "fulcrumtech",      b: true,  otlkMag: 16,   price: [29e3, 36e3],  marketCap: 2e12,   mv: [120, 130], spread: [1, 10], shareTx: [30e3, 90e3] },
  { sym: "STM",   host: "stormtech",        b: true,  otlkMag: 7,    price: [20e3, 25e3],  marketCap: 1.2e12, mv: [80, 90],   spread: [2, 10], shareTx: [36e3, 108e3] },
  { sym: "DCOMM", host: "defcomm",          b: true,  otlkMag: 10,   price: [6e3, 19e3],   marketCap: 900e9,  mv: [60, 70],   spread: [2, 10], shareTx: [36e3, 108e3] },
  { sym: "HLS",   host: "helios",           b: true,  otlkMag: 9,    price: [10e3, 18e3],  marketCap: 825e9,  mv: [55, 65],   spread: [2, 10], shareTx: [36e3, 108e3] },
  { sym: "VITA",  host: "vitalife",         b: true,  otlkMag: 7,    price: [8e3, 14e3],   marketCap: 1e12,   mv: [70, 80],   spread: [2, 10], shareTx: [36e3, 108e3] },
  { sym: "ICRS",  host: "icarus",           b: true,  otlkMag: 7.5,  price: [12e3, 24e3],  marketCap: 800e9,  mv: [60, 70],   spread: [3, 10], shareTx: [36e3, 108e3] },
  { sym: "UNV",   host: "univ-energy",      b: true,  otlkMag: 10,   price: [16e3, 29e3],  marketCap: 900e9,  mv: [50, 60],   spread: [2, 10], shareTx: [36e3, 108e3] },
  { sym: "AERO",  host: "aerocorp",         b: true,  otlkMag: 6,    price: [8e3, 17e3],   marketCap: 640e9,  mv: [55, 65],   spread: [3, 10], shareTx: [42e3, 126e3] },
  { sym: "OMN",   host: "omnia",            b: true,  otlkMag: 4.5,  price: [6e3, 15e3],   marketCap: 600e9,  mv: [65, 75],   spread: [4, 11], shareTx: [42e3, 126e3] },
  { sym: "SLRS",  host: "solaris",          b: true,  otlkMag: 8.5,  price: [14e3, 28e3],  marketCap: 705e9,  mv: [70, 80],   spread: [4, 12], shareTx: [42e3, 126e3] },
  { sym: "GPH",   host: "global-pharm",     b: true,  otlkMag: 10.5, price: [12e3, 30e3],  marketCap: 695e9,  mv: [55, 65],   spread: [4, 10], shareTx: [42e3, 126e3] },
  { sym: "NVMD",  host: "nova-med",         b: true,  otlkMag: 5,    price: [15e3, 27e3],  marketCap: 600e9,  mv: [70, 80],   spread: [4, 11], shareTx: [42e3, 126e3] },
  { sym: "WDS",   host: null,               b: true,  otlkMag: 1.5,  price: [4e3, 8.5e3],  marketCap: 450e9,  mv: [240, 260], spread: [5, 12], shareTx: [12e3, 54e3] },
  { sym: "LXO",   host: "lexo-corp",        b: true,  otlkMag: 6,    price: [4.5e3, 8e3],  marketCap: 300e9,  mv: [115, 135], spread: [5, 12], shareTx: [36e3, 108e3] },
  { sym: "RHOC",  host: "rho-construction", b: true,  otlkMag: 1,    price: [2e3, 7e3],    marketCap: 180e9,  mv: [50, 70],   spread: [3, 10], shareTx: [60e3, 126e3] },
  { sym: "APHE",  host: "alpha-ent",        b: true,  otlkMag: 10,   price: [4e3, 8.5e3],  marketCap: 240e9,  mv: [175, 205], spread: [5, 16], shareTx: [30e3, 90e3] },
  { sym: "SYSC",  host: "syscore",          b: true,  otlkMag: 3,    price: [3e3, 8e3],    marketCap: 200e9,  mv: [150, 170], spread: [5, 12], shareTx: [15e3, 90e3] },
  { sym: "CTK",   host: "computek",         b: true,  otlkMag: 4,    price: [1e3, 6e3],    marketCap: 185e9,  mv: [80, 100],  spread: [4, 12], shareTx: [60e3, 126e3] },
  { sym: "NTLK",  host: "netlink",          b: true,  otlkMag: 1,    price: [1e3, 5e3],    marketCap: 58e9,   mv: [200, 400], spread: [5, 20], shareTx: [18e3, 54e3] },
  { sym: "OMGA",  host: "omega-net",        b: true,  otlkMag: 0.5,  price: [1e3, 8e3],    marketCap: 60e9,   mv: [90, 110],  spread: [4, 13], shareTx: [30e3, 90e3] },
  { sym: "FNS",   host: "foodnstuff",       b: false, otlkMag: 1,    price: [500, 4.5e3],  marketCap: 45e9,   mv: [70, 80],   spread: [6, 10], shareTx: [60e3, 180e3] },
  { sym: "SGC",   host: "sigma-cosmetics",  b: true,  otlkMag: 0,    price: [1.5e3, 3.5e3], marketCap: 30e9,  mv: [100, 275], spread: [6, 14], shareTx: [20e3, 70e3] },
  { sym: "JGN",   host: "joesguns",         b: true,  otlkMag: 1,    price: [250, 1.5e3],  marketCap: 42e9,   mv: [200, 350], spread: [6, 14], shareTx: [15e3, 52e3] },
  { sym: "CTYS",  host: "catalyst",         b: true,  otlkMag: 13.5, price: [250, 1.5e3],  marketCap: 100e9,  mv: [120, 175], spread: [5, 14], shareTx: [24e3, 72e3] },
  { sym: "MDYN",  host: "microdyne",        b: true,  otlkMag: 8,    price: [15e3, 30e3],  marketCap: 360e9,  mv: [70, 80],   spread: [3, 10], shareTx: [90e3, 216e3] },
  { sym: "TITN",  host: "titan-labs",       b: true,  otlkMag: 11,   price: [12e3, 24e3],  marketCap: 420e9,  mv: [50, 70],   spread: [2, 10], shareTx: [90e3, 216e3] },
];

/** Deterministic uniform [0, 1) generator (mulberry32), so every run is replayable. */
export function rngOf(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The game's Stock (src/StockMarket/Stock.ts), minus the UI-only fields. */
class Stock {
  /** @param {typeof STOCK_METADATA[number]} m @param {() => number} rng */
  constructor(m, rng) {
    const int = (min, max) => Math.floor(rng() * (max - min + 1)) + min; // getRandomIntInclusive
    this.symbol = m.sym;
    this.host = m.host;
    this.price = int(m.price[0], m.price[1]);
    this.mv = int(m.mv[0], m.mv[1]) / 100;
    this.b = m.b;
    this.otlkMag = m.otlkMag;
    this.otlkMagForecast = this.getAbsoluteForecast();
    this.cap = int(this.price * 1e3, this.price * 25e3);
    this.spreadPerc = int(m.spread[0], m.spread[1]) / 10;
    this.shareTxForMovement = int(m.shareTx[0], m.shareTx[1]);
    this.shareTxUntilMovement = this.shareTxForMovement;
    // Total shares from the market cap, rounded to 100k; 20% of them can be held.
    this.totalShares = Math.round(m.marketCap / this.price / 1e5) * 1e5;
    this.maxShares = Math.round((this.totalShares * 0.2) / 1e5) * 1e5;
    this.playerShares = 0;
    this.playerAvgPx = 0;
    this.playerShortShares = 0;
    this.playerAvgShortPx = 0;
  }

  getAbsoluteForecast() { return this.b ? 50 + this.otlkMag : 50 - this.otlkMag; }
  getAskPrice() { return this.price * (1 + this.spreadPerc / 100); }
  getBidPrice() { return this.price * (1 - this.spreadPerc / 100); }

  getForecastIncreaseChance() {
    const diff = this.otlkMagForecast - this.getAbsoluteForecast();
    return (50 + Math.min(Math.max(diff, -45), 45)) / 100;
  }

  changeForecastForecast(v) { this.otlkMagForecast = Math.min(100, Math.max(0, v)); }

  cycleForecast(changeAmt, rng) {
    const up = rng() < this.getForecastIncreaseChance();
    // "The forecast increases" means the ABSOLUTE forecast: otlkMag grows for a
    // bull and shrinks for a bear.
    if (up === this.b) this.otlkMag += changeAmt;
    else this.otlkMag -= changeAmt;
    if (this.otlkMag < 0) {
      this.otlkMag *= -1;
      this.b = !this.b;
    }
    this.otlkMag = Math.min(this.otlkMag, 50);
  }

  cycleForecastForecast(changeAmt, rng) {
    this.changeForecastForecast(this.otlkMagForecast + (rng() < 0.5 ? changeAmt : -changeAmt));
  }

  influenceForecast(change) {
    if (this.otlkMag > FORECAST_INFLUENCE_LIMIT) {
      this.otlkMag = Math.max(FORECAST_INFLUENCE_LIMIT, this.otlkMag - change);
    }
  }

  influenceForecastForecast(change) {
    if (this.otlkMagForecast > 50) this.otlkMagForecast = Math.max(50, this.otlkMagForecast - change);
    else if (this.otlkMagForecast < 50) this.otlkMagForecast = Math.min(50, this.otlkMagForecast + change);
  }
}

/** processTransactionForecastMovement (StockMarketHelpers.ts), verbatim. */
function transactionForecastMovement(stock, shares) {
  if (!(shares > 0)) return;
  shares = Math.min(shares, stock.maxShares);

  const firstShares = stock.shareTxUntilMovement;
  if (shares <= firstShares) {
    stock.shareTxUntilMovement -= shares;
    if (stock.shareTxUntilMovement <= 0) {
      stock.shareTxUntilMovement = stock.shareTxForMovement;
      stock.influenceForecast(FORECAST_CHANGE_PER_MOVEMENT);
      stock.influenceForecastForecast(FORECAST_CHANGE_PER_MOVEMENT * (stock.mv / 100));
    }
    return;
  }

  const remainingShares = shares - firstShares;
  let numIterations = 1 + Math.ceil(remainingShares / stock.shareTxForMovement);
  stock.shareTxUntilMovement =
    stock.shareTxForMovement - ((shares - stock.shareTxUntilMovement) % stock.shareTxForMovement);
  if (stock.shareTxUntilMovement === stock.shareTxForMovement || stock.shareTxUntilMovement <= 0) {
    ++numIterations;
    stock.shareTxUntilMovement = stock.shareTxForMovement;
  }

  const forecastChange = FORECAST_CHANGE_PER_MOVEMENT * (numIterations - 1);
  stock.influenceForecast(forecastChange);
  stock.influenceForecastForecast(forecastChange * (stock.mv / 100));
}

/**
 * The market plus the one player trading in it.
 *
 * @param {object} [o]
 * @param {number} [o.seed]
 * @param {number} [o.money]        starting cash (BN8: $250m)
 * @param {boolean} [o.wse] @param {boolean} [o.tix]  access the player starts with
 * @param {boolean} [o.has4S]       start with the 4S Market Data TIX API
 * @param {boolean} [o.canShort]    BN8, or SF8.2 elsewhere
 * @param {number} [o.fourSCostMult] the BitNode's FourSigmaMarketDataApiCost
 */
export function makeMarket(o = {}) {
  const rng = rngOf(o.seed ?? 1);
  const player = {
    money: o.money ?? 250e6,
    hasWseAccount: o.wse ?? true,
    hasTixApiAccess: o.tix ?? true,
    has4SData: false,
    has4SDataTixApi: o.has4S ?? false,
  };
  const canShort = o.canShort ?? true;
  const costMult = o.fourSCostMult ?? 1;

  // Stocks are built first (their draws come first in initStockMarket), then
  // ticksUntilCycle: a uniform 1..TicksPerCycle, which is why a script that has
  // just started cannot know where in the cycle the market is.
  const stocks = STOCK_METADATA.map(m => new Stock(m, rng));
  const bySymbol = new Map(stocks.map(s => [s.symbol, s]));
  const byHost = new Map(stocks.filter(s => s.host).map(s => [s.host, s]));
  let ticksUntilCycle = Math.floor(rng() * MARKET.TicksPerCycle) + 1;
  let ticks = 0;
  const cycleTicks = [];   // tick numbers on which a cycle ran (for the tests)
  const stats = { buys: 0, sells: 0, commission: 0 };

  const stockOf = sym => {
    const s = bySymbol.get(sym);
    if (!s) throw new Error(`Invalid stock symbol: '${sym}'`);
    return s;
  };
  const needTix = () => {
    if (!player.hasTixApiAccess) throw new Error("You don't have TIX API Access!");
  };
  const need4S = () => {
    if (!player.has4SDataTixApi) throw new Error("You don't have 4S Market Data TIX API Access!");
  };
  const needShort = () => {
    if (!canShort) throw new Error("You must either be in BitNode-8 or have Source-File 8.2.");
  };

  /** One market update - processStockPrices with enough stored cycles. */
  function tick() {
    ticks++;
    if (--ticksUntilCycle <= 0) {
      for (const s of stocks) {
        if (rng() < CYCLE_FLIP_CHANCE) {
          s.b = !s.b;
          s.otlkMagForecast = 100 - s.otlkMagForecast; // flipForecastForecast
        }
      }
      ticksUntilCycle = MARKET.TicksPerCycle;
      cycleTicks.push(ticks);
    }

    const v = rng(); // ONE draw, shared by every stock this tick
    for (const s of stocks) {
      const av = (v * s.mv) / 100;
      let chc = (s.b ? 50 + s.otlkMag : 50 - s.otlkMag) / 100;
      if (s.price >= s.cap) {
        chc = 0.1; // the soft price cap
        s.b = false;
      }
      if (rng() < chc) s.price *= 1 + av;
      else s.price /= 1 + av;

      let otlkMagChange = s.otlkMag * av;
      if (s.otlkMag < 5) {
        if (s.otlkMag <= 1) otlkMagChange = 1;
        else otlkMagChange *= 10;
      }
      s.cycleForecast(otlkMagChange, rng);
      s.cycleForecastForecast(otlkMagChange / 2, rng);

      s.shareTxUntilMovement = Math.min(s.shareTxUntilMovement + 10, s.shareTxForMovement);
    }
  }

  // ── The four transactions (BuyingAndSelling.tsx) ────────────────────────────

  function buyLong(sym, shares) {
    const s = stockOf(sym);
    shares = Math.round(shares);
    if (!(shares > 0)) return 0;
    const total = Math.min(shares, s.maxShares) * s.getAskPrice() + MARKET.StockMarketCommission;
    if (player.money < total) return 0;
    if (shares + s.playerShares + s.playerShortShares > s.maxShares) return 0;
    const origTotal = s.playerShares * s.playerAvgPx;
    player.money -= total;
    s.playerShares = Math.round(s.playerShares + shares);
    s.playerAvgPx = (origTotal + total - MARKET.StockMarketCommission) / s.playerShares;
    transactionForecastMovement(s, shares);
    stats.buys++;
    stats.commission += MARKET.StockMarketCommission;
    return s.getAskPrice();
  }

  function sellLong(sym, shares) {
    const s = stockOf(sym);
    if (!(shares >= 0)) return 0;
    shares = Math.min(Math.round(shares), s.playerShares);
    if (shares === 0) return 0;
    player.money += shares * s.getBidPrice() - MARKET.StockMarketCommission;
    s.playerShares = Math.round(s.playerShares - shares);
    if (s.playerShares === 0) s.playerAvgPx = 0;
    transactionForecastMovement(s, shares);
    stats.sells++;
    stats.commission += MARKET.StockMarketCommission;
    return s.getBidPrice();
  }

  function openShort(sym, shares) {
    const s = stockOf(sym);
    shares = Math.round(shares);
    if (!(shares > 0)) return 0;
    // A short is opened at the BID (getBuyTransactionCost, PositionType.Short).
    const total = Math.min(shares, s.maxShares) * s.getBidPrice() + MARKET.StockMarketCommission;
    if (player.money < total) return 0;
    if (shares + s.playerShares + s.playerShortShares > s.maxShares) return 0;
    const origTotal = s.playerShortShares * s.playerAvgShortPx;
    player.money -= total;
    s.playerShortShares = Math.round(s.playerShortShares + shares);
    s.playerAvgShortPx = (origTotal + total - MARKET.StockMarketCommission) / s.playerShortShares;
    transactionForecastMovement(s, shares);
    stats.buys++;
    stats.commission += MARKET.StockMarketCommission;
    return s.getBidPrice();
  }

  function closeShort(sym, shares) {
    const s = stockOf(sym);
    if (!(shares >= 0)) return 0;
    shares = Math.min(Math.round(shares), s.playerShortShares);
    if (shares === 0) return 0;
    // ...and closed at the ASK: the stake back, plus (entry - ask) per share.
    const origCost = shares * s.playerAvgShortPx;
    const profit = (s.playerAvgShortPx - s.getAskPrice()) * shares - MARKET.StockMarketCommission;
    player.money += origCost + profit;
    s.playerShortShares = Math.round(s.playerShortShares - shares);
    if (s.playerShortShares === 0) s.playerAvgShortPx = 0;
    transactionForecastMovement(s, shares);
    stats.sells++;
    stats.commission += MARKET.StockMarketCommission;
    return s.getAskPrice();
  }

  // ── hack / grow influence (PlayerInfluencing.ts) ────────────────────────────

  /**
   * One finished hack() or grow() carrying { stock: true } against `host`, having
   * moved `fraction` of the server's MAX money. Returns whether the roll moved
   * the second-order forecast. A host with no stock is a no-op, as in the game.
   * @param {"hack" | "grow"} kind @param {string} host @param {number} fraction
   */
  function influence(kind, host, fraction) {
    const s = byHost.get(host);
    if (!s) return false;
    if (!(rng() < fraction)) return false;
    s.changeForecastForecast(s.otlkMagForecast + (kind === "grow" ? FF_CHANGE_FROM_HACK : -FF_CHANGE_FROM_HACK));
    return true;
  }

  /** What everything is worth if sold this instant, commissions included. */
  function netWorth() {
    let total = player.money;
    for (const s of stocks) {
      if (s.playerShares > 0) total += s.playerShares * s.getBidPrice() - MARKET.StockMarketCommission;
      if (s.playerShortShares > 0) {
        total += s.playerShortShares * (2 * s.playerAvgShortPx - s.getAskPrice()) - MARKET.StockMarketCommission;
      }
    }
    return total;
  }

  // ── The ns facade lib/stocks.js runs against ────────────────────────────────

  const logs = [];
  const ns = {
    args: /** @type {any[]} */ ([]),
    print: (...a) => { logs.push(a.join(" ")); },
    tprint: (...a) => { logs.push(a.join(" ")); },
    disableLog: () => {},
    sleep: async () => {},
    getPlayer: () => ({ money: player.money }),
    format: { number: n => (Math.abs(n) >= 1e3 ? Number(n).toExponential(3) : String(Math.round(n * 100) / 100)) },
    stock: {
      getConstants: () => ({ ...MARKET }),
      hasWseAccount: () => player.hasWseAccount,
      hasTixApiAccess: () => player.hasTixApiAccess,
      has4SData: () => player.has4SData,
      has4SDataTixApi: () => player.has4SDataTixApi,
      getSymbols: () => { needTix(); return stocks.map(s => s.symbol); },
      getPrice: sym => { needTix(); return stockOf(sym).price; },
      getAskPrice: sym => { needTix(); return stockOf(sym).getAskPrice(); },
      getBidPrice: sym => { needTix(); return stockOf(sym).getBidPrice(); },
      getMaxShares: sym => { needTix(); return stockOf(sym).maxShares; },
      getPosition: sym => {
        needTix();
        const s = stockOf(sym);
        return [s.playerShares, s.playerAvgPx, s.playerShortShares, s.playerAvgShortPx];
      },
      getForecast: sym => { need4S(); return stockOf(sym).getAbsoluteForecast() / 100; },
      getVolatility: sym => { need4S(); return stockOf(sym).mv / 100; },
      buyStock: (sym, shares) => { needTix(); return buyLong(sym, shares); },
      sellStock: (sym, shares) => { needTix(); return sellLong(sym, shares); },
      buyShort: (sym, shares) => { needTix(); needShort(); return openShort(sym, shares); },
      sellShort: (sym, shares) => { needTix(); needShort(); return closeShort(sym, shares); },
      purchaseWseAccount: () => {
        if (player.hasWseAccount) return true;
        if (player.money < MARKET.WseAccountCost) return false;
        player.money -= MARKET.WseAccountCost;
        return (player.hasWseAccount = true);
      },
      purchaseTixApi: () => {
        if (player.hasTixApiAccess) return true;
        if (player.money < MARKET.TixApiCost) return false;
        player.money -= MARKET.TixApiCost;
        return (player.hasTixApiAccess = true);
      },
      purchase4SMarketData: () => {
        if (player.has4SData) return true;
        const cost = MARKET.MarketData4SCost * costMult;
        if (!player.hasWseAccount || player.money < cost) return false;
        player.money -= cost;
        return (player.has4SData = true);
      },
      purchase4SMarketDataTixApi: () => {
        needTix();
        if (player.has4SDataTixApi) return true;
        const cost = MARKET.MarketDataTixApi4SCost * costMult;
        if (player.money < cost) return false;
        player.money -= cost;
        return (player.has4SDataTixApi = true);
      },
      nextUpdate: async () => { tick(); return MARKET.msPerStockUpdate; },
    },
  };

  return {
    ns, player, stocks, bySymbol, byHost, stats, logs, cycleTicks,
    tick, influence, netWorth,
    buyLong, sellLong, openShort, closeShort,
    get ticks() { return ticks; },
    get ticksUntilCycle() { return ticksUntilCycle; },
  };
}
