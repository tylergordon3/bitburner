// offline/edit-save.mjs
//
// The EditSaveFile exploit: "by editing your save file" - which is exactly what
// the game's source tells players to do (src/Exploits/Exploit.ts: "Yes, you're
// supposed to gain the EditSaveFile exploit by editing your real save file").
// This adds that one entry to the save's exploit list and writes the result to a
// NEW file next to the original; the original is never touched.
//
//   node offline/edit-save.mjs [path/to/bitburnerSave_x.json.gz] [--exploit Name ...]
//
// Then in the game: Options > Import game, pick the file this printed, confirm.
// Export your current game first (Options > Export game) so nothing played since
// the save was written is lost - or save in the game right before running this
// and edit that save.
//
// --exploit adds other SF-1 entries by name (the list is in Exploit.ts). The
// game's own comment on that: "TBH, you could gain them all the same way, but
// that is not our challenge to you." tools/exploits.js earns them the intended way.
import { basename, dirname, join } from "node:path";
import { newestSave, readSave, writeSave } from "./save-lib.mjs";

const args = process.argv.slice(2);
const extra = [];
let file = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--exploit") extra.push(args[++i]);
  else file = args[i];
}
file ??= newestSave();
if (!file) {
  console.error("No save found. Pass one: node offline/edit-save.mjs <bitburnerSave_*.json.gz>");
  process.exit(1);
}

const loaded = readSave(file);
const before = [...(loaded.player.exploits ?? [])];
const wanted = ["EditSaveFile", ...extra.filter(Boolean)];
loaded.player.exploits = [...new Set([...before, ...wanted])];
const added = loaded.player.exploits.filter(e => !before.includes(e));
if (added.length === 0) {
  console.log(`Nothing to do: ${file} already has ${wanted.join(", ")}.`);
  process.exit(0);
}

const out = join(dirname(file), basename(file).replace(/^bitburnerSave_/, "bitburnerSave_edited_"));
writeSave(out, loaded);
// Read it back: a save that does not round-trip must not be handed to the game.
const check = readSave(out);
if (!added.every(e => check.player.exploits.includes(e)) || check.player.bitNodeN !== loaded.player.bitNodeN) {
  console.error("The edited file did not read back correctly - do not import it.");
  process.exit(1);
}
console.log(`Added ${added.join(", ")}.`);
console.log(`Wrote ${out}`);
console.log("Import it with Options > Import game. The original save is untouched.");
