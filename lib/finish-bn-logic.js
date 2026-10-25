// lib/finish-bn-logic.js
//
// The two decisions lib/finish-bn.js makes before it ends a BitNode, as pure
// functions (no Netscript, 0GB) so the Node tests can pin them down:
//   - may it finish at all (the HUD's FINISH switch, three-state)?
//   - what BitNode options does the next node get (BN12's SF12 override, a
//     challenge run's, or none)?

import { forReset } from "./config.js";
import { campaignStep, challengeEntryOptions, recursionEntryOptions } from "./capabilities.js";

// BN12, the one node entered with its own Source-File overridden (entryOptionsFor).
const RECURSION_NODE = 12;

/**
 * The FINISH permission from what the finisher can see.
 *   false     - the player turned FINISH off. Stop, permanently.
 *   true      - the daemon has read the toggle and it's on. Proceed.
 *   undefined - nobody has decided yet (globalThis is wiped by a page load, and
 *               an orphaned finisher can come back before the daemon seeds the
 *               flag). Then the persisted file decides - but only on home, the
 *               one host whose copy of it is the truth; there an absent file means
 *               "never configured", i.e. on. Off home an absent file is no answer.
 * @param {boolean | undefined} flag - globalThis.gordAutoFinish
 * @param {string} stored - the persisted toggle file's text ("" when absent)
 * @param {boolean} onHome - is the finisher running on home?
 * @returns {"off" | "on" | "unknown"}
 */
export function finishPermissionFrom(flag, stored, onHome) {
  if (flag === false) return "off";
  if (flag === true) return "on";
  const off = String(stored ?? "").trim() === "off";
  if (onHome) return off ? "off" : "on";
  return off ? "off" : "unknown";
}

/**
 * The BitNode options to enter `nextBN` with:
 *   - BN12, however it was chosen: Source-File 12 overridden to
 *     campaign.recursionLevel (0), so the run plays at BN12.1's difficulty and
 *     still raises the owned level (capabilities.js recursionEntryOptions);
 *   - the challenge options when the campaign's next step is the challenge run
 *     of exactly that node;
 *   - otherwise undefined (the game's defaults - which also clears whatever this
 *     run was entered with).
 * The overrides come back as the Map destroyW0r1dD43m0n insists on.
 * @param {any} reset - ns.getResetInfo()
 * @param {number} nextBN
 * @param {Set<string> | null} held - achievement IDs held (null = unknown)
 * @returns {any}
 */
export function entryOptionsFor(reset, nextBN, held) {
  const campaign = forReset(reset).campaign;
  if (nextBN === RECURSION_NODE) {
    const recursion = recursionEntryOptions(reset, campaign.recursionLevel ?? null);
    return recursion ? { sourceFileOverrides: new Map(recursion.sourceFileOverrides) } : undefined;
  }
  const step = campaignStep(reset, campaign.order, held);
  if (!step.challenge || step.node !== nextBN) return undefined;
  const options = challengeEntryOptions(reset, nextBN);
  if (!options) return undefined;
  return { ...options, sourceFileOverrides: new Map(options.sourceFileOverrides) };
}

/**
 * What the finisher's announcement says about the options: " (challenge run)",
 * " (Source-File 12 at level 0 for the run)", or nothing.
 * @param {number} nextBN @param {any} options - entryOptionsFor's answer
 * @returns {string}
 */
export function entryLabel(nextBN, options) {
  if (!options) return "";
  if (nextBN === RECURSION_NODE) {
    const level = options.sourceFileOverrides?.get?.(RECURSION_NODE);
    return level === undefined ? "" : ` (Source-File 12 at level ${level} for the run)`;
  }
  return " (challenge run)";
}
