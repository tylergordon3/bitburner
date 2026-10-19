// offline/edit-save.mjs
//
// The EditSaveFile exploit: "by editing your save file" - which is exactly what
// the game's source tells players to do (src/Exploits/Exploit.ts: "Yes, you're
// supposed to gain the EditSaveFile exploit by editing your real save file").
// This adds that one entry to the save's exploit list and writes the result to a
// NEW file next to the original; the original is never touched.
//
//   node offline/edit-save.mjs [path/to/save] [--exploit Name ...] [--achievement ID ...]
//
// Then in the game: Options > Import game, pick the file this printed, confirm.
// Export your current game first (Options > Export game) and pass THAT file, so
// nothing played since the last save on disk is lost.
//
// --exploit adds other SF-1 entries by name (the list is in Exploit.ts). The
// game's own comment on that: "TBH, you could gain them all the same way, but
// that is not our challenge to you." tools/exploits.js earns them the intended way.
//
// --achievement adds an entry to the player's achievement list. It exists for
// UNACHIEVABLE, whose condition is a literal `false` under the comment "Hey
// Players! Yes, you're supposed to modify this to get the achievement!"
// (src/Achievements/Achievements.ts). The dev menu that could grant it is only
// built into development builds, never the Steam release. The game never
// re-checks an achievement it finds in the list, and syncs the list to Steam
// when Options has Steam achievement sync on.
import { basename, dirname, join } from "node:path";
import { newestSave, readSave, writeSave } from "./save-lib.mjs";

const args = process.argv.slice(2);
const extra = [];
const achievementIds = [];
let file = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--exploit") extra.push(args[++i]);
  else if (args[i] === "--achievement") achievementIds.push(args[++i]);
  else file = args[i];
}
file ??= newestSave();
if (!file) {
  console.error("No save found. Pass one: node offline/edit-save.mjs <bitburnerSave_*.json.gz>");
  process.exit(1);
}

const loaded = readSave(file);
const p = loaded.player;

const before = [...(p.exploits ?? [])];
const wanted = ["EditSaveFile", ...extra.filter(Boolean)];
p.exploits = [...new Set([...before, ...wanted])];
const added = p.exploits.filter(e => !before.includes(e));

const held = new Set((p.achievements ?? []).map(a => a.ID));
const newAchievements = [...new Set(achievementIds.filter(Boolean))].filter(id => !held.has(id));
p.achievements = [...(p.achievements ?? []), ...newAchievements.map(ID => ({ ID, unlockedOn: Date.now() }))];

if (added.length === 0 && newAchievements.length === 0) {
  console.log(`Nothing to do: ${file} already has ${[...wanted, ...achievementIds].join(", ")}.`);
  process.exit(0);
}

// A name without the usual prefix (an export renamed by hand) still gets a new
// file: the replace alone would leave the name unchanged and write over it.
const name = basename(file);
const out = join(dirname(file), name.startsWith("bitburnerSave_")
  ? name.replace(/^bitburnerSave_/, "bitburnerSave_edited_")
  : `edited_${name}`);
writeSave(out, loaded);
// Read it back: a save that does not round-trip must not be handed to the game.
const check = readSave(out);
const checkIds = new Set((check.player.achievements ?? []).map(a => a.ID));
if (
  !added.every(e => check.player.exploits.includes(e)) ||
  !newAchievements.every(id => checkIds.has(id)) ||
  check.player.bitNodeN !== p.bitNodeN
) {
  console.error("The edited file did not read back correctly - do not import it.");
  process.exit(1);
}
if (added.length) console.log(`Added exploit(s): ${added.join(", ")}.`);
if (newAchievements.length) console.log(`Added achievement(s): ${newAchievements.join(", ")}.`);
console.log(`Wrote ${out}`);
console.log("Import it with Options > Import game. The original save is untouched.");
