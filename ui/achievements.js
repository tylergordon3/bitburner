// ui/achievements.js
//
// The ACHIEVE dashboard cards: where the campaign goes next, and which of the
// achievements that take planning are still missing, with the one-line how for
// each. Reads globalThis.gordAchievements (published by lib/achievements.js from
// the save - Netscript has no achievement API) and globalThis.gordCampaign (the
// daemon's plan, lib/daemon-lib.js plannedNextNode).
//
// Returns [] until the save has been read, so the tab shows its placeholder.

import { card, label, statRow, el } from "./dashboard-lib.js";
import { CONFIG, CHALLENGE, forNode, isChallengeRun } from "../lib/config.js";
import { ACHIEVEMENT_PLAN, missingByGroup } from "../lib/achievements-logic.js";
import { sourceFileLevel } from "../lib/capabilities.js";

// Steps of the plan shown ahead of the current one; the rest is a count.
const STEPS_SHOWN = 8;

/**
 * @param {NS} ns
 * @param {typeof import("./dashboard-lib.js").COLORS} C
 * @returns {any[]}
 */
export function extraCards(ns, C) {
  const published = globalThis.gordAchievements;
  if (!published) return [];
  const reset = ns.getResetInfo();
  const cards = [planCard(C, reset, published)];
  if (!Array.isArray(published.ids)) {
    cards.push(card(C, "ACHIEVEMENTS", [label(C, `Could not read the save: ${published.error || "unknown error"}`)]));
    return cards;
  }
  const groups = missingByGroup(published.ids);
  const missing = groups.reduce((sum, g) => sum + g.items.length, 0);
  const total = Object.keys(ACHIEVEMENT_PLAN).length;
  cards.push(card(C, "ACHIEVEMENTS", [
    statRow(C, ">", `${published.ids.length} held`, `${missing} of the ${total} planned ones to go`, missing ? C.yellow : C.green),
    statRow(C, ">", "SF-1 exploits", `${(published.exploits ?? []).length} of 11`, C.blue),
    label(C, "tools/exploits.js earns the exploits; docs/ACHIEVEMENTS.md has the plan for the rest."),
  ]));
  for (const group of groups) {
    cards.push(card(C, group.label, group.items.map(a =>
      el("div", { style: { marginBottom: "5px" } },
        el("div", { style: { fontSize: "12px", color: C.blue } }, a.name),
        el("div", { style: { fontSize: "11px", color: C.dim } }, a.how),
      ))));
  }
  return cards;
}

/**
 * The steps of campaign.order that are still open, in order, with the one the
 * daemon will enter next marked.
 * @param {any} reset @param {Set<string>} held
 */
export function openSteps(reset, held) {
  const current = Number(reset?.currentNode ?? 0);
  return CONFIG.campaign.order.map(([node, target]) => {
    if (target === "challenge") {
      const id = CHALLENGE[node]?.achievement;
      const inHand = node === current && isChallengeRun(reset);
      return { node, text: `BN${node} challenge`, done: !!id && held.has(id), inHand };
    }
    const level = sourceFileLevel(reset, node);
    return { node, text: `BN${node} to ${node}.${target}`, done: level >= target, inHand: node === current && level + 1 >= target && level < target };
  }).filter(step => !step.done);
}

function planCard(C, reset, published) {
  const plan = globalThis.gordCampaign;
  const held = new Set(Array.isArray(published.ids) ? published.ids : []);
  const steps = openSteps(reset, held);
  const rows = [];

  const here = `BN${reset.currentNode} ${forNode(reset.currentNode).name ?? ""}${isChallengeRun(reset) ? " - CHALLENGE RUN" : ""}`;
  rows.push(statRow(C, ">", "This run", here, isChallengeRun(reset) ? C.yellow : C.blue));
  if (plan) {
    const next = plan.override != null
      ? (plan.override > 0 ? `BN${plan.override} (your choice)` : "halt (your choice)")
      : plan.waiting ? "waiting for the save to be read"
      : plan.node > 0 ? `BN${plan.node}${plan.challenge ? " as its challenge run" : ""}`
      : "plan complete - you choose";
    rows.push(statRow(C, ">", "After this node", next, plan.waiting ? C.yellow : C.green));
  }
  for (const step of steps.slice(0, STEPS_SHOWN)) {
    rows.push(statRow(C, step.inHand ? "*" : "-", step.text, step.inHand ? "this run earns it" : "", step.inHand ? C.green : C.dim));
  }
  if (steps.length > STEPS_SHOWN) rows.push(label(C, `...and ${steps.length - STEPS_SHOWN} more steps (campaign.order in lib/config.js).`));
  if (steps.length === 0) rows.push(label(C, "Every step of campaign.order is done."));
  return card(C, "CAMPAIGN", rows);
}
