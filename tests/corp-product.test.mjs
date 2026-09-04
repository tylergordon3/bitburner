// tests/corp-product.test.mjs
//
// Guards lib/corp-lib.js's designCity - the resolution that decides where a
// product division develops its products, and therefore where corp-office grows
// the main "progress"-split office.
//
// The bug this exists for: config used to name a fixed design city (Aevum) while
// expandIndustry founds every division in Sector-12. makeProduct THROWS for a
// city the division doesn't occupy, and corp-steady wraps it in did(), so a BN3
// Tobacco division developed nothing at all - silently, every cycle - while
// rounds 3-4 waited on the finished product it could never produce. Nothing in
// the suite covered the product pipeline, which is why it shipped.
//
// Importable under Node because corp-lib's whole import closure (lib/config.js)
// is Netscript-free.

import { test } from "node:test";
import assert from "node:assert/strict";
import { designCity } from "../lib/corp-lib.js";

/** A minimal ns whose getDivision returns `cities` (or throws, like the real API). */
function fakeNs(divisions) {
  return {
    corporation: {
      getDivision(name) {
        if (!(name in divisions)) throw new Error(`no division ${name}`);
        return divisions[name];
      },
    },
  };
}

test("designs in the city the division was founded in, not a configured one", () => {
  // expandIndustry's free office: Sector-12 first, expansions appended after.
  const ns = fakeNs({ Tobacco: { cities: ["Sector-12"] } });
  assert.equal(designCity(ns, "Tobacco"), "Sector-12");
});

test("the choice is stable as the division expands", () => {
  // The first city stays first, so a product mid-development never has its
  // main office demoted to the R&D support split underneath it.
  const before = fakeNs({ Tobacco: { cities: ["Sector-12"] } });
  const after = fakeNs({ Tobacco: { cities: ["Sector-12", "Aevum", "Chongqing"] } });
  assert.equal(designCity(after, "Tobacco"), designCity(before, "Tobacco"));
});

test("never returns a city the division does not occupy", () => {
  const ns = fakeNs({ Tobacco: { cities: ["New Tokyo", "Ishima"] } });
  const city = designCity(ns, "Tobacco");
  assert.ok(["New Tokyo", "Ishima"].includes(city), `${city} is not occupied`);
});

test("null - not a guess - when the division can't be read or holds no city", () => {
  assert.equal(designCity(fakeNs({}), "Tobacco"), null);            // getDivision throws
  assert.equal(designCity(fakeNs({ Tobacco: { cities: [] } }), "Tobacco"), null);
});
