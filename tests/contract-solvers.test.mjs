// tests/contract-solvers.test.mjs
// Unit tests for the pure contract solvers. Run: npm test  (needs Node >=20).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  solveContract,
  supportedContractTypes,
  lzDecompress,
  lzCompress,
  CONTRACT_TYPES as T,
} from "../lib/contract-solvers.js";

const solve = (type, data) => solveContract(type, data).answer;

test("unknown types are skipped, not guessed", () => {
  assert.deepEqual(solveContract("Some Future Contract", null), { supported: false });
  assert.equal(supportedContractTypes().length, 30);
});

test("number-answer solvers", () => {
  assert.equal(solve(T.primeFactor, 2 * 2 * 3 * 17), 17);
  assert.equal(solve(T.maxSubarray, [-2, 1, -3, 4, -1, 2, 1, -5, 4]), 6);
  assert.equal(solve(T.totalWays, 5), 6);
  assert.equal(solve(T.totalWaysII, [4, [1, 2]]), 3);
  assert.equal(solve(T.jumpI, [2, 3, 1, 1, 4]), 1);
  assert.equal(solve(T.jumpI, [3, 2, 1, 0, 4]), 0);
  assert.equal(solve(T.jumpII, [2, 3, 1, 1, 4]), 2);
  assert.equal(solve(T.triangle, [[2], [3, 4], [6, 5, 7], [4, 1, 8, 3]]), 11);
  assert.equal(solve(T.pathsI, [3, 3]), 6);
  assert.equal(solve(T.traderI, [7, 1, 5, 3, 6, 4]), 5);
  assert.equal(solve(T.traderII, [7, 1, 5, 3, 6, 4]), 7);
  assert.equal(solve(T.traderIV, [2, [3, 2, 6, 5, 0, 3]]), 7);
  assert.equal(solve(T.primeCount, [1, 10]), 4); // 2,3,5,7
});

test("array-answer solvers", () => {
  assert.deepEqual(solve(T.spiral, [[1, 2, 3], [4, 5, 6], [7, 8, 9]]), [1, 2, 3, 6, 9, 8, 7, 4, 5]);
  assert.deepEqual(solve(T.mergeIntervals, [[1, 3], [2, 6], [8, 10], [15, 18]]), [[1, 6], [8, 10], [15, 18]]);
  assert.deepEqual(
    [...solve(T.generateIPs, "25525511135")].sort(),
    ["255.255.11.135", "255.255.111.35"].sort(),
  );
  assert.deepEqual(solve(T.twoColoring, [4, [[0, 1], [1, 2], [2, 3], [3, 0]]]), [0, 1, 0, 1]);
  assert.deepEqual(solve(T.twoColoring, [3, [[0, 1], [1, 2], [2, 0]]]), []); // odd cycle -> impossible
  assert.deepEqual(solve(T.shortestPath, [[0, 0, 0], [0, 0, 0]]).length, 3); // DRR / RRD etc, length 3
});

test("hamming encode/decode round-trips", () => {
  for (const value of [1, 8, 21, 255, 1000]) {
    const encoded = solve(T.hammingEncode, value);
    assert.equal(solve(T.hammingDecode, encoded), value);
  }
});

test("compression solvers", () => {
  assert.equal(solve(T.rle, "aaaabbbccd"), "4a3b2c1d");
  // LZ: compressing then decompressing must reproduce the input.
  for (const s of ["aaaaaaaaa", "abracadabra", "aAaAaAaAaA", "mississippi"]) {
    assert.equal(lzDecompress(lzCompress(s)), s);
    assert.equal(solve(T.lzDecode, lzCompress(s)), s);
  }
});

test("encryption solvers", () => {
  assert.equal(solve(T.caesar, ["ABC", 1]), "ZAB");
  assert.equal(solve(T.vigenere, ["AAAA", "B"]), "BBBB");
});

test("square root returns a stringifiable BigInt", () => {
  assert.equal(solve(T.squareRoot, 16n), 4n);
  assert.equal(solve(T.squareRoot, 17n), 4n); // nearest integer root
  assert.equal(String(solve(T.squareRoot, 100n)), "10");
});
