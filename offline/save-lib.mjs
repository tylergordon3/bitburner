// offline/save-lib.mjs
//
// Reading and writing Bitburner save files from Node, OUTSIDE the game. Shared by
// the two offline tools. Not a game script: nothing in here is synced or run by
// the bot.
//
// A save is a JSON object { ctor, data } whose data.PlayerSave (and friends) are
// JSON strings in turn. On disk it is either gzip of that JSON (.json.gz - the
// Steam build) or base64 of it (.json - the browser build).
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import { homedir } from "node:os";

/** Folders the Steam build is known to keep saves in, per platform. */
export function saveRoots() {
  const roots = [];
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "bitburner", "saves"));
  roots.push(join(homedir(), "Library", "Application Support", "bitburner", "saves"));
  roots.push(join(homedir(), ".config", "bitburner", "saves"));
  // WSL: the Windows profile is under /mnt/c/Users/<name>.
  const users = "/mnt/c/Users";
  if (existsSync(users)) {
    for (const user of readdirSync(users)) roots.push(join(users, user, "AppData", "Roaming", "bitburner", "saves"));
  }
  return roots.filter(r => { try { return statSync(r).isDirectory(); } catch { return false; } });
}

/** The newest bitburnerSave_* file under the known save folders, or null. */
export function newestSave() {
  let best = null;
  for (const root of saveRoots()) {
    for (const id of readdirSync(root)) {
      const dir = join(root, id);
      let names = [];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.startsWith("bitburnerSave_")) continue;
        const file = join(dir, name);
        const time = statSync(file).mtimeMs;
        if (!best || time > best.time) best = { file, time };
      }
    }
  }
  return best?.file ?? null;
}

/**
 * @param {string} file
 * @returns {{ save: any, player: any, gzip: boolean }} `player` is the parsed
 *   PlayerSave.data - edit it in place and pass the whole thing to writeSave.
 */
export function readSave(file) {
  const raw = readFileSync(file);
  const gzip = raw[0] === 0x1f && raw[1] === 0x8b;
  const text = gzip ? gunzipSync(raw).toString("utf8") : Buffer.from(raw.toString("utf8"), "base64").toString("utf8");
  const save = JSON.parse(text);
  const playerSave = JSON.parse(save.data.PlayerSave);
  return { save, player: playerSave.data, gzip, playerSave };
}

/**
 * Write a save in the same encoding it was read in. Never the file it came from:
 * the caller picks a new name, so the original is always there to go back to.
 * @param {string} file @param {{ save: any, playerSave: any, gzip: boolean }} loaded
 */
export function writeSave(file, loaded) {
  loaded.save.data.PlayerSave = JSON.stringify(loaded.playerSave);
  const text = JSON.stringify(loaded.save);
  writeFileSync(file, loaded.gzip ? gzipSync(text) : Buffer.from(text, "utf8").toString("base64"));
}
