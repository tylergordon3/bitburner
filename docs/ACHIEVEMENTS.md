# Achievements, exploits and the BitNode order

What is still missing, what each one takes, and what the bot does about it. Written
2026-10-04 from the save of 2026-10-03 (in BN7 going for 7.2), brought up to date
2026-10-23, against the game source at v3.0.2 (`src/Achievements/Achievements.ts`,
`src/Exploits/*`, `src/BitNode/BitNode.tsx`).

New to the game? Read [GUIDE.md](GUIDE.md) first.

## Where things stand

As of the save of 2026-10-23, in **BN14.1** (about 60 hours in):

- **72 of 109** achievements held. The 37 missing are all listed below, and the plan
  table covers every one of the game's 109 (checked against `AchievementData.json`).
- **11 of 11** exploits (Source-File -1): all held, and UNACHIEVABLE with them.
- Source-Files: 1.3, 2.1, 3.3, 4.3, 5.3, 6.1, 7.3, 9.3, 10.3, 13.1. Never finished: BN8,
  11, 12, 14 (in progress), 15.

Cheapest still open, in this order: **The Void** (`run tools/void.js`, a second),
**Ten Steps Ahead** (the Go helper's streak focus, on in BN14 - hours), **Massive debt**
(`tools/debt.js`, 13 idle hours at a node's end).

To see the current list at any time:

| Where | What |
| --- | --- |
| HUD, **ACHIEVE** tab | The campaign's next steps and every planned achievement still missing. The daemon reads them out of the save with [`lib/achievements.js`](../lib/achievements.js) (Netscript has no achievement API; `singularity.getSaveData` does have the save). |
| `node offline/achievements.mjs` | The same list from the newest save file, without the game. |

The 37 fall into five groups (the exploits are done). In the order worth doing them:

| Group | Count | How they are earned |
| --- | --- | --- |
| First Source-Files, all at level 3 | 6 | The campaign (`campaign.order`). |
| Challenges | 12 | Campaign steps of `[n, "challenge"]`. |
| The money run | 10 | One long run with a mature corporation, held open. |
| Grinds | 6 | Time - and for two of them, dark net automation that does not exist yet. |
| One-offs | 3 | A trick each. |

---

## 1. Exploits (Source-File -1)

*All eleven held since 2026-10-18; kept here as the record of how.*

The developers left eleven easter eggs for players who poke at the game itself. Each is a
level of SF-1 (0.1% on most multipliers per level, so a trophy rather than a strategy) and
a hidden achievement. From the source: *"finding ways to break a hacking game is very much
a learning experience in the spirit of the game."*

```
run tools/exploits.js
```

It costs exactly 1.6GB (it has to: `ns.bypass` only pays out to a script at the base cost),
stays up for about 16 minutes, and puts back everything it touches when it exits or is
killed.

| Exploit | How | Who does it |
| --- | --- | --- |
| UndocumentedFunctionCall | `ns.exploit()` | the script |
| Bypass | `ns.bypass(document)` from a 1.6GB script, reaching `document` without naming it | the script |
| INeedARainbow | `ns.rainbow(guess)` with the right word | the script (it reports which guess matched) |
| TimeCompression | The game's 15-second heartbeat pays out if two beats land under 500ms apart. The script hands the next beat a zero delay, once. | the script |
| PrototypeTampering | Every 15 minutes the game checks `(55).toExponential()`. The script answers wrongly for the number 55 only, and restores the original the moment it has been asked. | the script, within 15 minutes |
| Unclickable | A hidden `<div>` that pays out only for a real click made while it is still computed as hidden. The script shows it and hides it again in the capture phase of your click. | **you click the green box** |
| N00dles | City > New Tokyo > Noodle Bar > "Eat noodles". | **you walk there**; the script presses the button if it is running |
| RealityAlteration | `ns.alterReality()` holds a local variable that is always false and pays out if it is true. Only a debugger can change another function's local. | **you**, with DevTools: see below |
| TrueRecursion | "Beat BN1 in megabyteburner 2000": the Arcade in New Tokyo runs an old Bitburner in a frame, and pays out when that inner game reports a destroyed BitNode. | **you**: see below |
| EditSaveFile | Edit your save. | **you**: `node offline/edit-save.mjs` |
| YoureNotMeantToAccessThis | Open the dev menu. | held |

**RealityAlteration.** Open DevTools (Steam build: the *Debug* menu > *Activate*; browser:
F12), then `run tools/exploits.js --reality`. Ten seconds later the script calls
`ns.alterReality()`, and the `console.warn` inside it hits a `debugger` statement. In the
Call Stack pane choose the frame *below* the top one (the game's `alterReality`), find the
single `false` boolean under Scope, double-click it, type `true`, and resume.

**TrueRecursion** (done this way 2026-10-18). The Arcade (`src/Arcade/ui/BBCabinet.tsx`)
grants it for a `message` event whose data is `true` and whose origin is
`https://bitburner-official.github.io` - the inner game's page. The inner game is Bitburner
v0.30.0: only `.script` files, in a sandboxed interpreter that cannot reach the page, so a
script in there cannot send it. The DevTools console can:

1. New Tokyo > Arcade, inner game showing (the tutorial does not matter).
2. DevTools (Steam: *Debug* > *Activate*) > Console. In the context dropdown at its top
   left, switch `top` to the inner game's frame (`bitburner-legacy` /
   `bitburner-official.github.io`). From `top` the origin is the main game's and nothing
   happens.
3. `parent.postMessage(true, "*")`, Enter. (If pasting is blocked, type `allow pasting` first.)

The honest way still works too: finish BN1 in the inner game.

**EditSaveFile.** The source says it in so many words: *"Yes, you're supposed to gain the
EditSaveFile exploit by editing your real save file."* Save in the game, then outside it:

```bash
node offline/edit-save.mjs
```

It adds the one entry to a **copy** of the newest save (`bitburnerSave_edited_...`), reads the
copy back to check it, and prints the path. Import it with Options > Import game. The
original file is never written to.

**UNACHIEVABLE.** Its condition is the literal `false`, under the comment *"Hey Players! Yes,
you're supposed to modify this to get the achievement!"* (`src/Achievements/Achievements.ts`).
The game's dev menu has an Achievements panel that grants it, but the sidebar only offers
that menu in development builds (`NODE_ENV === "development"`), never the Steam release -
`ns.openDevMenu()` there is the ASCII-art joke that pays out YoureNotMeantToAccessThis, not
the menu. So edit the save, the same way as EditSaveFile: export, then

```bash
node offline/edit-save.mjs <the exported file> --achievement UNACHIEVABLE
```

and import the copy it writes. The game never re-checks an achievement it finds in the
save, and syncs the list to Steam when Options has Steam achievement sync on.

---

## 2. The BitNode order

`campaign.order` in [`lib/config.js`](../lib/config.js) is the plan every daemon follows
when it finishes a node. Reviewed 2026-10-04; what changed and why:

**BN7.3 is no longer first.** Its prize is a free Blade's Simulacrum on joining Bladeburner -
an augmentation the Bladeburners faction sells anyway - and a BN7 run is the longest kind
there is (the current one is past 112 hours). It moves to the back, where it doubles as the
BN7 challenge run.

**BN9.3 and BN5.3 come first** because their daemons have run live, they are short, and
what they give compounds over the ~35 runs still to come: 128GB of home RAM and a built
hacknet server at the start of every node (SF9.2, 9.3), and +12%/+14% on every hacking
multiplier (SF5.2, 5.3). BN5 is also the first live run of `lib/gang-daemon.js`, the engine
BN11, BN12 and BN15 share, in a node that has already been beaten with the code it grew
out of.

**Then the first run of each new node, biggest permanent gain first:**

| Step | What the Source-File gives | The run |
| --- | --- | --- |
| BN13.1 | Stanek's Gift in every node: free multipliers, charged with spare RAM | Bladeburner finish (hacking level x0.25, world daemon x3); rank x0.45, Stanek power x2 |
| BN14.1 | IPvGO bonuses doubled, everywhere | Bladeburner finish (hacking level x0.4, world daemon x5); rank x0.6, skill costs x2 |
| BN11.1 | Each augmentation bought raises the others' price 4% less (6%, 7% at levels 2, 3); company favor pays salary | Gang daemon; augs x2, server money x0.01, crime money x3 |
| BN8.1 | WSE and TIX API free from minute one in every node (8.2: shorts; 8.3: limit orders) | Stock trader only: every other income is zero |
| BN12.1 | Start every node with NeuroFlux Governor at the Source-File's level | Gang daemon; everything 2% worse per level |

**Then the second run of each as its challenge run** (section 3) and the third run plain,
so that no node needs a fourth entry: BN13, 14, 8, then 11.3 and 12.3, then BN2, BN6 and
BN7, whose second/third runs are still owed.

**Then the challenge-only runs** of nodes already at level 3: BN9, BN3. (BN1 and BN10,
the two cheap ones, were moved up on 2026-10-23 to sit right after BN12.1, ahead of the
long Bladeburner challenge runs of BN13 and BN14. BN10 ends by hand, which makes its
wait the natural place for the 13 hours of `tools/debt.js`.)

**BN15 and BN12-to-50 last.** The bot has no hacking finish in BN15 (The Red Pill comes
only from the dark net's labs there). The Bladeburner black ops end it without one -
`destroyW0r1dD43m0n` accepts them in place of the hacking requirement - and
`bn15/daemon.js` runs the Bladeburner engine (`BITNODE[15].bladeburner.enabled`, on
since 2026-10-23). Slow (rank x0.2, skills x3), but it earns SF15 and the BN15 challenge
with no dark net code. Switched off, the plan halts in BN15 for the player.

Three things the order cannot do for you:

- **BN10 is finished by hand.** The bot never backdoors `w0r1d_d43m0n` there
  (`backdoor.skipFinalHost`). When the plan reaches `[10, "challenge"]` it enters BN10 with
  the right options and then waits for you, and you pick the next node on the BitVerse
  screen yourself.
- **None of the new daemons (BN8, BN11-15) and no challenge run has been through a live
  game.** The plan enters them anyway; watch the first run of each. An explicit argument
  (`run /bn7/daemon.js 9`) overrides the plan for the rest of a node, and the HUD's FINISH
  switch holds any finish.
- **Speed demon** (a node inside 48 hours) is not planned for; BN5.2, BN5.3 or BN12.1 with
  today's Source-Files should do it without help.

---

## 3. Challenge runs

Each is "finish BN-n without its mechanic". A step of `[n, "challenge"]` in `campaign.order`
makes the bot enter node n with the BitNode options that make the restriction a rule of the
game (so neither a script nor a misclick can break it), and play that run with a config
that stops reaching for what is gone (`CHALLENGE` in `lib/config.js`). The run still awards
a Source-File level, which is why each sits before the node's level step.

| Node | Entered with | What the bot does differently | Notes |
| --- | --- | --- | --- |
| BN1 | `restrictHomePCUpgrade` | Nothing: home stops at 128GB / 1 core by the game's hand; purchased servers are not capped. | Daemon and on-home helpers must fit 128GB. |
| BN2 | `disableGang` | Plain daemon (`bn1/daemon.js`); no gang bootstrap. | World daemon x5 (hacking 15,000 at x0.8). The long one. |
| BN3 | `disableCorporation` | Plain daemon; corp scripts off. | Augs x3 in money and rep. A gang (SF2) carries it. |
| BN6, BN7 | `disableBladeburner` | Plain daemon; finish by hacking. | Hacking level x0.35, world daemon x2: 6,000 real levels. The corporation (valuation x0.2) and gang pay for it. |
| BN8 | `disable4SData` | The trader never buys 4S and trades on its own forecast estimate throughout. | It already starts that way. |
| BN9 | `disableHacknetServer` | Plain daemon; no hacknet servers, no hacknet nodes. | The condition is zero hacknet income *and* spending. |
| BN10 | `disableSleeveExpAndAugmentation` | Nothing: sleeves still work, they just never gain. | Finished by hand. |
| BN13 | (marker only) | Stanek's Gift is never accepted. | |
| BN14 | (marker only) | The IPvGO helper is not started, and exits if started by hand (it reads the run's config with `forReset`). Do not play the board through the API yourself either: one API move or cheat voids it for the whole node. | A second run, so SF14.1 does not depend on it. |
| BN15 | - | Nothing here ever calls `dnet.heartbleed`; any BN15 finish earns it, the black-ops one included. | |
| BN12 | - | `[12, 50]`: fifty runs, each 2% harder than the last. | The last thing on the list. |

*The marker.* BN13 and BN14 have no option to set - their challenge is something the player
must not do - so every challenge entry also carries a Source-File override that overrides
nothing (a level-3 file set to 3). It is what lets every script see, from
`getResetInfo()` alone, that this run is the challenge run.

*Caveats.* The plain daemon has only ever run in BN4. In a challenge run it is working
against a node's multipliers without the mechanic that node's own daemon leans on, so these
are the slowest runs on the plan; if one stalls, `run /bn1/daemon.js <next node>` (or the
BitVerse screen) moves on and the step stays open for later.

---

## 4. The money run

Ten achievements need more money than any ordinary run sees, and all of them fall out of the
same thing: a corporation left to grow for days.

| Achievement | Needs |
| --- | --- |
| Lobbying is great! | The Government Partnership corporation unlock. |
| Small town | One division with 3,000 employees (six offices of 500). |
| Full network | All 20 hacknet servers (SF9). |
| That's the new limit | One hacknet server fully upgraded: level 300, 8,192GB, 128 cores, cache 15. The last cores cost about $1e30. |
| It's time to install | 40 augmentations queued at once. Every NeuroFlux level bought is its own queue entry, so NeuroFlux can fill it. Each queued aug multiplies the next one's price by 1.9 (1.767 with SF11.3) - except Shadows of Anarchy and dark net lab augs, which neither pay nor raise it. |
| I asked for this | 100 different augmentations installed in one node. |
| Neuroflux is love... | NeuroFlux Governor level 255 installed. Cost and reputation both grow 14% a level and the level resets every node. |
| Download more ram | Home RAM at 2^30 GB. The last doubling is about $1e19. |
| Here comes the money! | $1e18 in hand. |
| Power Overwhelming | Hacking level 100,000 - the multiplier NeuroFlux 255 brings, in a node that does not cut hacking levels. |

**Where.** A node where the corporation is at full strength and hacking levels are not cut:
BN1 (every multiplier 1) is the cleanest, as an extra run that is *not* the BN1 challenge
(which caps home RAM); BN2.3 (corporation softcap 0.9, hacking level 0.8) costs no extra
entry. BN12 holds the softcap at 0.8 at every level, and BN3's challenge forbids the corp.

**How.** `moneyRunNode` in `lib/config.js` names the node; that node is then played with the
`MONEY_RUN` overlay (same file):

- the bot never finishes the node - you backdoor `w0r1d_d43m0n` yourself when the list is done;
- installs wait for 40 queued augmentations and for nothing else;
- hacknet servers are bought whether or not they pay back (10% of spare cash);
- the corporation's growth loop is on (it is by default after round 4 anyway);
- Bladeburner banks 100,000 skill points once its black ops are done - which does
  nothing in BN1 or BN2, where Bladeburner is off (`bladeburner.enabled`). See Grinds.

The corporation side was rebuilt on 2026-10-04: after round 4 it now runs a growth loop
(`corp.growth`) with no seat or level ceilings. In a model of the game's formulas it passes
3,000 Tobacco employees about 150 cycles after round 4, reaches $1e30/s profit after about
310, and puts $3e30 in your hand shortly after. That is a model, not a live run - watch
the CORP card's Growth line and `run tools/corp-status.js` on the first one. The corp also
banks for the two dividend-tax unlocks now (the second is "Lobbying is great!"). The
hacknet half is unchanged: outside this overlay the fleet stops at about nine servers,
because it only buys what pays back.

---

## 5. Grinds

| Achievement | Needs | Plan |
| --- | --- | --- |
| Wolf of Wall Street | $1e15 stock profit inside one node. | BN8 is where the trader runs longest and with the whole bankroll; three BN8 runs are on the plan. If none gets there, hold one open. |
| Smart! | Intelligence 255 (148 today - about 28 times the experience). | Comes with everything else on this page: finishing nodes, grafting, black ops. Not worth a detour. |
| You should really spend those... | 100,000 Bladeburner skill points unspent. | Put `bladeburner.skillPointBank: 100_000` in a Bladeburner node's BITNODE entry (BN6 or BN7 - rank x1 / x0.6) and turn **FINISH off**: the bank only holds points once the black ops are done or Operation Daedalus is ready and *held*, and a node whose finish is on ends the moment Daedalus is done. Then about 300,000 more rank. Not set anywhere today (the money run's copy has no Bladeburner to act on). |
| Ten Steps Ahead | Ten IPvGO wins in a row against Illuminati (no faction needed). | The Go helper's **streak focus** (`go.streak`, on in BN14): every game goes to Illuminati until the streak lands - the achievement list or the game's own highest-streak record says when - then the rotation resumes. Streaks are kept per opponent, so nothing else breaks one but a loss, a board abandoned mid-game, or an aug install. Daedalus plays Illuminati's move 90% of the time and the helper beat it 114-14 in BN14, so expect hours. |
| Make your Own Network | 50 backdoored dark net servers at once (stasis-linked ones do not count). | Any node: DarkscapeNavigator.exe ($50m on the dark web, $30m at Chongqing's Shadowed Walkway) opens the dark net. Not automated. |
| Into the Depths | The Sword installed: the sixth dark net lab's prize (seventh in BN15). | The labs need BN15 or SF15, and each lab's prize is chosen by what is *installed* - six lab clears with an install after each, in one node. Not automated. |

## 6. One-offs

| Achievement | How |
| --- | --- |
| Massive debt ($1b in debt) | Classes charge without checking your balance. `run tools/debt.js` (dry run) explains; `--go` unassigns the gang, sets corporation dividends to 0 (income `killall` does not stop), and puts you and every sleeve in Powerhouse Gym - about 13 hours with eight sleeves. It gives up if the balance keeps rising. End of a node, FINISH off - the BN10 challenge's manual finish is the natural slot. |
| IPvGO anticheat | Get ejected for cheating: a failed cheat, after any earlier cheat attempt in the same game, has a 10% chance. The cheat API needs SF14.2, or BN14 with SF14.1 already held (`checkCheatApiAccess`) - so not in a first BN14 run, and never in the BN14 challenge run (a cheat voids it). The `[14, 3]` run, or any node after it. Not automated. |
| The Void | `run tools/void.js`. The Void is a location with no city that grants it when its page opens; `singularity.goToLocation("The Void")` opens it from anywhere. By hand: Ishima > "0x6C1" (the glitch), wait about 25 seconds. |
| UNACHIEVABLE | Edit the save - see the note in section 1. |

---

## Not automated

Things on this page the code does not do yet, in the order I would build them:

1. **A dark net player** (`ns.dnet`): a crawler that runs itself on dark net servers, 24
   password puzzles, and the labs. Two achievements need it, and it is the fast way through
   BN15 (The Red Pill is the fourth lab's prize there). Large - 1,500 lines or more. Until
   then BN15 goes through the black ops (`BITNODE[15].bladeburner.enabled`).
2. **Stronger investment rounds.** Rounds 3-4 still use fixed targets and fall well short of
   the corporation manual's offer benchmarks in the model; `corp.growth.fromRound: 3` is the
   untested opt-in.
3. A deliberate **cheat-until-ejected** tool for IPvGO anticheat (about 80 lines: a
   board, then cheats until a failure ejects you), usable once SF14.2 is held. The
   Illuminati streak mode exists (`go.streak`).
