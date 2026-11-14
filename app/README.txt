LANTERN CLIENT  -  a companion panel for Dauntless Forever (Dauntless 1.14.7 only), single player
===========================================================================================
Created by Alex, powered by Claude.

A separate window next to the game: an item giver that works while you play, currencies and game rules.
The Dauntless Forever launcher is not changed.

WHAT IT DOES
  Give items (also while the game runs)
    Any of the 3,500+ weapons, armour, lanterns, parts, omnicells, gliders, pets, skins and other cosmetics in the
    1.14.7 catalog. Every cell (Cells view), Max weapon levels (every weapon type to level 20), Unlock all cosmetics,
    and any amount of Rams, Merits, tokens, keys and cell cores.
    Remove items: take unused gear and cosmetics away in bulk (a smaller inventory stutters less in game).
  Game rules
    1.14.7's rules: XP speeds, reward amounts, free crafting, free platinum, extra loadout slots (launcher's page).
  Behemoth overlay (Settings)
    The behemoth you are fighting, over the game: its real name, its health and each part's health (head, legs,
    tail...), in your colour preset. Click-through, shown only while the game is in front, gone when the behemoth
    dies or leaves. Position, size, background and what it shows are in Settings. Needs the game mod (Set up), with
    "Also run mods on my servers" on: part health only exists on the hunt server. While it is on, Dauntless
    Forever's own Boss Health Bar is switched off (and back on when you turn the overlay off).
  Live feed
    Everything that reaches your game, as it happens, with sounds and optional desktop alerts.

FIRST TIME
  1. In the Dauntless Forever launcher, 1.14.7 must be downloaded and Set up, and you must have pressed Play once
     and made a character.
  2. Close the game. Run Lantern-Client-Setup.exe. It installs Lantern Client for you (no admin rights needed), adds it to
     the Start Menu and the Desktop, and opens it. From then on, open "Lantern Client" like any other app.
  3. After the intro: paste the key you were given (LANTERN-...) into the box and press Confirm key. Once it is
     accepted, Enter takes you in, with a short welcome each time it opens. The key is kept: you enter it once.
  4. The first time, a short tour shows how to set up and what each page does (Settings > Show the tour replays it).
     (Windows may say it protects your PC the first time: the exe is not code-signed. "More info", "Run anyway".)
  3. For the overlay: press "Set up" in the amber bar. It installs the game mod (and UE4SS, the mod loader, if you don't have it)
     and turns on Modded mode and "Also run mods on my servers" for 1.14.7.
  4. Press Play in the launcher. The "Mod" pill at the top lights up when the mod answers.

GIFTS WHILE YOU PLAY (live delivery)
  While the game runs, the trainer logs in to the game's own backend with your player key (data\player.key), the same
  way the game does, and sends each gift as a normal inventory transaction. The backend saves it at once, on its own
  connection, so nothing can clash with what the game is saving at that moment.
  - Within 2 seconds you get a line in game chat: "[Lantern] Added: ...".
  - The game shows new items the next time it loads your inventory: any loading screen (Ramsgate to a hunt and back).
    The trainer follows the backend's log and tells you the moment that happens ("Now in your game", a chat line, a
    sound, and a desktop alert if you turned those on).
  - Instant refresh (Give items page, experimental, off by default): asks the game to reload your inventory right
    away. The mod tries functions on the game's inventory that look like a refresh and take no input, one per gift,
    and keeps the one that the backend log proves worked. If none works, gifts still arrive at the next loading screen.
  - Max weapon levels waits until you close the game: 1.14.7 keeps weapon XP per weapon type in your save, and the
    backend holds that in memory while you play.

UPDATES (automatic)
  Lantern Client updates itself. Each time it opens it checks for a new version (a second or two; offline it just
  opens), installs it and starts it. While it is open it also checks every few hours: when a new version is ready,
  a "Restart to update" button appears at the top; one click and it reopens on the new version. The speaker
  button's menu shows your version and has "Check for updates".
  - Every update is signed. Lantern Client only installs files signed with the project's key and matching their
    checksums, so nobody else can push code to your PC through it.
  - If a new version fails to start, Lantern Client goes back to the one before by itself and skips that version.
  - Your choices, waiting gifts and the game mod's switches are kept across updates.
  - Remove it from Windows Settings > Apps (Lantern Client), like any other app. Your game and save are not touched.

HOW THE GAME MOD WORKS (and why it needs server mods)
  Dauntless runs every hunt on a hidden server copy of the game on your PC, and that server owns behemoth health.
  The Lantern Client mod (UE4SS Lua) runs in your game and in those server copies; the panel writes its switches to
  trainer-toggles.json in the mod's folder and every copy reads it twice a second. With the overlay and Instant refresh
  off, the mod does nothing else, so it costs nothing in game.

SLAYERS CLUB
  The Slayers Club (the game's own club: buff, +weapon XP and other perks) is a mod of its own, SlayersClub, on
  Dauntless Forever's Mods page next to Lantern Client's (DFTrainer). Switch it on and Lantern Client puts the club in
  your save; switch it off and it is taken out once the game is closed. It shows after your next login. It needs
  Lantern Client running and the DFTrainer mod on: without them nothing changes, and the panel says why. Only the
  club's two entitlements (ent_boost_vip, escalation_xp_boost_entitlement) are touched; the save is backed up first.
  Playing in a friend's game: their save holds your character until it comes home, so Lantern changes your save
  after you leave, and the club travels with you the next time you join. In their game you have it from then on.

BETTEROMNIS
  Small buffs to Omnicell passives, a mod of its own, BetterOmnis, on Dauntless Forever's Mods page next to Lantern
  Client's (DFTrainer). Actives are not changed, and the disc shows the new numbers:
    Bastion shields received 15% -> 18%, Iceborne health +100 -> +125, Discipline healing penalty 50% -> 45%,
    Tempest attack speed 10% -> 15% (also speeds the Storm Dash animation), Revenant lifesteal 2% -> 5%.
  Revenant also gets a new passive, Blood Ward: below 50% health you take 23% less damage and gain +8% lifesteal
  (Revenant State still blocks all healing). Its disc text is English in every language.
  Switch it on and Lantern Client puts its pak (zzzzzzzzzzzzzzzz_BetterOmnis_P.pak) in Archon\Content\Paks; off takes it
  out. Changes wait until the game and its hunt servers are fully closed. It needs Lantern Client running and the
  DFTrainer mod on: without them the pak is taken out. After a game update that changes those files it pauses itself.
  Full effect only in hunts you host (the host's hunt server decides); in someone else's hunt your disc shows the new
  numbers but you get theirs.

MODEL SWAPS
  Play as another character. Model Swaps tab: pick a character and press Apply; "Use my own Slayer" puts everything
  back. Only how your own Slayer looks on your screen changes: your armour stays equipped (it is only not drawn),
  and no stat, hitbox, movement, animation, other player, NPC or behemoth is touched. Other players see your Slayer.
  Your choice is kept across restarts.
  Characters: "Find characters on Sketchfab" searches Sketchfab's free, downloadable models and adds one with a press
  (downloading needs a free Sketchfab account: its API token, from sketchfab.com/settings/password, is kept on your
  PC and sent only to Sketchfab; searching needs no account); a folder someone else converted can be copied
  into the library folder the tab names; "Add a character" converts a glTF model file (.gltf / .glb, a humanoid
  standing in a T-pose or A-pose, with or without a skeleton). Converting needs Python 3 with numpy and Pillow, and
  once the Oodle library (oo2core_9_win64.dll, not shipped with the game) to read four of the game's own files;
  characters copied from someone else need neither. Lantern hosts no models: each one keeps its author, licence
  and Sketchfab page in its model.json.
  How: each character is a pak of its own in Archon\Content\Paks (LanternModel_<id>_P.pak: new files under
  /Game/Lantern/ModelSwaps/, nothing of the game replaced). In the game, Lantern's native library draws it on a part
  of its own that follows your Slayer's pose, and hides the Slayer's body, head, hair, armour and accessories.
  A character put in while the game runs shows after a game restart; switching between characters already in the
  game, the Size slider and going back to your Slayer happen at once. It needs Modded mode on.
  Limits: the face does not animate, hair and cloth do not move on their own, see-through parts are cut-outs, and
  weapons stay on the Slayer's own hands (far from 100% size they sit a little off the character's hands).

HOST MODE LAG FIX (retired in 3.9.37: Dauntless Forever fixes it itself, github.com/addison2k/DauntlessForever/issues/12)
  3.9.32-3.9.36 patched one line of DF's backend\recorder-1147.js so the host's own game did not go out to the relay
  and back. Lantern no longer patches it and the Hotfix tab is gone. On a PC it patched, Lantern puts DF's original
  back once (from recorder-1147.js.lantern-original, only over its own fix) and deletes that copy.

FRIEND TAB (retired in 3.9.39: no longer needed now that Dauntless Forever fixed the Host Mode delay)
  3.9.35-3.9.38 set up direct co-op over Tailscale. The tab is gone; play together with Host Mode again. If you hosted
  from it, Lantern removes the Tailscale address it wrote into DF's data\lan_ip.txt once. Tailscale itself stays
  installed: uninstall it from Windows Settings > Apps if you do not want it.

GOOD TO KNOW
  - The in-game parts could not be tested in the real game when they were written (no Windows or game there). The
    panel, the item giving and the live delivery were tested against a copy of the 1.14.7 package and its real backend with a test
    save and a stand-in for the game's backend. If the overlay stays empty, look for [DFTrainer] lines (the mod kept its folder name) in <game>\Archon\Binaries\Win64\ue4ss\UE4SS.log.
  - Sounds and the intro: the speaker button at the top right (sound on or off, volume, intro on or off).
  - Fonts come from Google Fonts; offline, the panel uses Windows' own font instead.
  - With the game closed, items go into your save through the package's own tools\items.js, which backs the save up
    first (backup\inventory, last 10 kept).
  - Lantern Client is its own window (drawn by WebView2, the web engine built into Windows 10 and 11; no browser
    opens). Closing it closes Lantern Client; the part that delivers gifts keeps running about 3 minutes longer (or
    until gifts waiting for the game to close are in). Opening Lantern Client again brings the window back.

KEYS
  Lantern Client needs a key from the owner. A key is made for one person, can run for 1 day up to a year or
  forever, and works offline. Settings > About shows whose key it is and how long it has left; Remove key there
  takes it out. Without a valid key the panel only shows the key screen and the game mod switches itself off.
  A key the owner revokes stops working the next time the client starts (or within a few hours while it runs).

FOR THE OWNER: MAKING KEYS
  1. On the key screen ("I'm the owner") or in Settings > About (Owner key...), pick lantern-owner-key.pem.
     That unlocks the client for you and adds the Keys page. Keep that file private and backed up: it is what
     signs keys, and it cannot be made again (a new one would mean a new app version and new keys for everyone).
  2. Keys page: enter who it is for, pick how long it lasts, Generate key. It is copied for you: send it to them.
  3. To revoke a key: Revoke on the Keys page. That copies its id and opens licenses/revoked.txt on GitHub: add
     the id as a new line and commit. Clients pick it up within a few hours, or the next time they start.

FILES (in %LOCALAPPDATA%\DFTrainer once installed; the folder kept its name from before the rename)
  Lantern Client.exe ..... the launcher: opens the panel, installs updates
  app\<version>\ ......... the panel itself (server.js, live.js, ui, the game mod); the last two versions are kept
  trainer-settings.json .. your choices and waiting gifts
  license.json ........... your key
  logs\ .................. launcher.log and panel.log, if something needs looking into

To turn the game mod off: Dauntless Forever launcher > 1.14.7 > Mods, Lantern Client off.

Licence: AGPL-3.0-only, like Dauntless Forever, whose tools it uses. See LICENSE.
