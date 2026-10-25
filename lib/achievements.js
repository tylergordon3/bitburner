// lib/achievements.js
//
// One-shot: finds out which achievements and SF-1 exploits the player holds and
// publishes them as globalThis.gordAchievements, then exits. Netscript has no
// achievement API, but it can hand a script the save (singularity.getSaveData),
// and the save has the list - so this reads the save, takes the two arrays it
// wants, and throws the rest away.
//
// Who wants it:
//   - the campaign plan: a step of [n, "challenge"] is done when CHALLENGE_BNn is
//     held (lib/capabilities.js campaignStep). Without this the plan cannot tell,
//     and it WAITS rather than guess - so the daemon runs this before it plans a
//     finish.
//   - the HUD's ACHIEVE tab (ui/achievements.js): what is still missing, and how.
//   - the OWNED Source-File levels (`ownedSF`), from the same read: in a run
//     entered with a Source-File override - every BN12 run, at SF12 level 0 -
//     getResetInfo() reports the override, and the plan must not mistake it for
//     what is owned (lib/capabilities.js ownedLevelOf). The HUD's SF tab too.
//
// The daemon (lib/daemon-core.js) runs it off-home when the table is missing or
// older than achievements.refreshMs. globalThis outlives the script.
//
// Cost: 1.6 base + getSaveData (1GB x the node's Singularity multiplier). The
// save is megabytes once inflated, so it is read as a stream and dropped as soon
// as both lists have gone past - the player record is the first thing in it.

import { parseSaveProgress, progressScanner } from "./achievements-logic.js";

const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * @param {Uint8Array} bytes - what getSaveData returned: a gzip stream, or the
 *   bytes of a base64 string (the two save formats the game writes).
 * @returns {Promise<{ ids: string[], exploits: string[], ownedSF: [number, number][] | null } | null>}
 */
async function readProgress(bytes) {
  if (bytes[0] !== GZIP_MAGIC[0] || bytes[1] !== GZIP_MAGIC[1]) {
    return parseSaveProgress(atob(new TextDecoder().decode(bytes)));
  }
  const win = /** @type {any} */ (globalThis);
  const stream = new Blob([/** @type {any} */ (bytes)]).stream().pipeThrough(new win.DecompressionStream("gzip"));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const scanner = progressScanner();
  try {
    while (true) {
      const { done, value } = await reader.read();
      const found = scanner.feed(value ? decoder.decode(value, { stream: true }) : "");
      if (found) return found;
      if (done) return scanner.partial();
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  let progress = null;
  let error = "";
  try {
    progress = await readProgress(await ns.singularity.getSaveData());
    if (!progress) error = "the save had no achievement list where one was expected";
  } catch (e) {
    error = String(e);
  }

  // Published even on failure (with ids: null): the daemon relaunches this while
  // the table is MISSING, and a save this cannot read must not have it relaunched
  // every tick. A failed read is retried on the normal refresh interval instead.
  globalThis.gordAchievements = {
    ids: progress?.ids ?? null,
    exploits: progress?.exploits ?? null,
    // The Source-File levels OWNED, as [sf, level] pairs (null: not in the save).
    ownedSF: progress?.ownedSF ?? null,
    error,
    updatedAt: Date.now(),
  };
  ns.print(progress
    ? `Published ${progress.ids.length} achievements, ${progress.exploits.length} exploits and ${progress.ownedSF ? progress.ownedSF.length : "no"} owned Source-Files.`
    : `WARN: could not read achievements from the save: ${error}`);
}
