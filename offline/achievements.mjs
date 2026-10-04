// offline/achievements.mjs
//
// What is still missing, read straight from a save file - no game needed.
//   node offline/achievements.mjs [path/to/bitburnerSave_x.json.gz]
// With no path it takes the newest save the Steam build has written. In the game
// the same list is the HUD's ACHIEVE tab (ui/achievements.js); the plan behind it
// is docs/ACHIEVEMENTS.md.
import { newestSave, readSave } from "./save-lib.mjs";
import { ACHIEVEMENT_PLAN, missingByGroup } from "../lib/achievements-logic.js";

const file = process.argv[2] ?? newestSave();
if (!file) {
  console.error("No save found. Pass one: node offline/achievements.mjs <bitburnerSave_*.json.gz>");
  process.exit(1);
}
const { player } = readSave(file);
const owned = (player.achievements ?? []).map(a => a.ID);
const sourceFiles = (player.sourceFiles?.data ?? []).slice().sort((a, b) => a[0] - b[0]);

console.log(`Save: ${file}`);
console.log(`In BitNode ${player.bitNodeN}. Source-Files: ${sourceFiles.map(([n, l]) => `${n}.${l}`).join(", ") || "none"}`);
console.log(`Exploits (SF-1): ${(player.exploits ?? []).join(", ") || "none"}`);
console.log(`Achievements held: ${owned.length}. Planned ones still missing: ${Object.keys(ACHIEVEMENT_PLAN).filter(id => !owned.includes(id)).length} of ${Object.keys(ACHIEVEMENT_PLAN).length}.`);
for (const { label, items } of missingByGroup(owned)) {
  console.log(`\n${label}`);
  for (const a of items) console.log(`  ${a.name}  [${a.id}]\n      ${a.how}`);
}
