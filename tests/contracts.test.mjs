// tests/contracts.test.mjs
// The coding-contract helper's I/O loop (lib/contracts.js) against a fake ns: what
// it asks the game for, what it submits, and what it must never do (guess at an
// unknown type, retry a wrong answer). Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { main } from "../lib/contracts.js";
import { CONTRACT_TYPES as T } from "../lib/contract-solvers.js";

class Stop extends Error {}

/** Run main() for `passes` scans of a two-server network holding `contracts`. */
async function scan(contracts, passes) {
  const fetched = [];
  const submitted = [];
  let pass = 0;
  const ns = {
    disableLog() {}, print() {}, tprint() {},
    scan: host => (host === "home" ? ["n00dles", "foodnstuff"] : ["home"]),
    ls: (host, pattern) => {
      assert.equal(pattern, ".cct");
      return contracts.filter(c => c.host === host && !c.gone).map(c => c.file);
    },
    codingcontract: {
      getContract: (file, host) => {
        const c = contracts.find(x => x.file === file && x.host === host);
        fetched.push(file);
        return {
          type: c.type,
          data: c.data,
          submit: answer => {
            submitted.push({ file, answer });
            const right = JSON.stringify(answer) === JSON.stringify(c.expect);
            if (right) c.gone = true;
            return right ? "Gained 1234.56789 reputation for CyberSec" : "";
          },
        };
      },
    },
    sleep: async () => { if (++pass >= passes) throw new Stop(); },
  };
  try {
    await main(ns);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
  const state = globalThis.gordContractState;
  delete globalThis.gordContractState;
  delete globalThis.gordEvents;
  return { fetched, submitted, state };
}

test("contracts.js: solves what it knows, leaves unknown types alone, never retries a wrong answer", async () => {
  const contracts = [
    { host: "n00dles", file: "prime.cct", type: T.primeFactor, data: 2 * 2 * 3 * 17, expect: 17 },
    // A BigInt answer goes to the game as a string.
    { host: "n00dles", file: "root.cct", type: T.squareRoot, data: 10n ** 40n, expect: "100000000000000000000" },
    { host: "foodnstuff", file: "future.cct", type: "Some Future Contract", data: [1, 2, 3], expect: null },
    // The game disagrees with the solver here: one attempt, then hands off.
    { host: "foodnstuff", file: "wrong.cct", type: T.maxSubarray, data: [1, 2, 3], expect: -1 },
  ];
  const { fetched, submitted, state } = await scan(contracts, 3);

  assert.deepEqual(submitted, [
    { file: "prime.cct", answer: 17 },
    { file: "root.cct", answer: "100000000000000000000" },
    { file: "wrong.cct", answer: 6 },
  ], "exactly one submission per solvable contract, none for the unknown type, no retry of the wrong one");
  // The unknown type is looked at on every pass (it may be one a human solves),
  // the failed one is not even fetched again, and solved ones are gone.
  assert.deepEqual(fetched, ["prime.cct", "root.cct", "future.cct", "wrong.cct", "future.cct", "future.cct"]);
  assert.equal(state.solvedTotal, 2);
  assert.equal(state.failedTotal, 1);
  assert.equal(state.found, 2, "the last scan still sees the unknown and the failed contract");
  assert.deepEqual(state.unsupported, ["Some Future Contract"]);
  assert.match(state.lastReward, /1,234\.57 reputation/);
});

test("RAM: contracts.js pays for getContract (15GB) only - not getContractType + getData + attempt (20GB)", () => {
  const src = readFileSync(new URL("../lib/contracts.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // The analyser bills by NAME, so the words themselves must not appear in code.
  for (const name of ["getContractType", "getData", "attempt", "getDescription", "getNumTriesRemaining"]) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(src), `lib/contracts.js names ${name}`);
  }
  assert.deepEqual([...new Set([...src.matchAll(/\bns\.codingcontract\.(\w+)/g)].map(m => m[1]))], ["getContract"]);
});
