LANTERN CLIENT  -  a companion panel for Dauntless Forever (Dauntless 1.6.2), single player
===========================================================================================
Created by Alex, powered by Claude.

A separate window next to the game: cheats you switch on and off, and an item giver that works while you play.
The Dauntless Forever launcher is not changed.

WHAT IT DOES
  Cheats (owner only: Owner > Cheats; switch any time, also mid-hunt)
    God mode ........... your health refills constantly and after every hit (hotkey F8 in game)
    Infinite stamina ... the stamina bar stays full                            (hotkey F9 in game)
    Damage ............. x2 to x50, or One hit, against behemoths
    Move speed ......... x0.5 to x3
  Give items (also while the game runs)
    Any of the 3,000+ weapons, armour, lanterns, parts, accessories and cosmetics, at max level where the item has
    levels. Max all my gear, Unlock all cosmetics, and any amount of Rams, Merits, tokens, keys, materials, cell cores.
  Game rules
    Weapon XP, Hunt Pass XP, loot amount, free crafting, unlimited resupply (the launcher's Game Rules page).
  Live feed
    Everything that reaches your game, as it happens, with sounds and optional desktop alerts.

FIRST TIME
  1. In the Dauntless Forever launcher, 1.6.2 must be downloaded and Set up, and you must have pressed Play once
     and made a character.
  2. Close the game. Run Lantern-Client-Setup.exe. It installs Lantern Client for you (no admin rights needed), adds it to
     the Start Menu and the Desktop, and opens it. From then on, open "Lantern Client" like any other app.
  3. After the intro: paste the key you were given (LANTERN-...) into the box and press Confirm key. Once it is
     accepted, Enter takes you in, with a short welcome each time it opens. The key is kept: you enter it once.
  4. The first time, a short tour shows how to set up and what each page does (Settings > Show the tour replays it).
     (Windows may say it protects your PC the first time: the exe is not code-signed. "More info", "Run anyway".)
  3. Press "Set up" in the amber bar. It installs the trainer mod (and UE4SS, the mod loader, if you don't have it)
     and turns on Modded mode and "Also run mods on my servers" for 1.6.2.
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
  - Raising gear you already own to max level waits until you close the game: the game re-saves weapon XP with a
    version number, and changing that number mid-session could make its next save of that weapon fail.

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

HOW CHEATS WORK (and why they need server mods)
  Dauntless runs every hunt on a hidden server copy of the game on your PC, and that server owns health and damage.
  The Lantern Client mod (UE4SS Lua) runs in your game and in those server copies; the panel writes your switches to
  trainer-toggles.json in the mod's folder and every copy reads them a few times a second.

GOOD TO KNOW
  - The in-game parts could not be tested in the real game when they were written (no Windows or game there). The
    panel, the item giving and the live delivery were tested against a copy of the 1.6.2 server files with a test
    save and a stand-in for the game's backend. Each cheat card says whether the mod found what it needs; if one shows
    an amber line, look for [DFTrainer] lines (the mod kept its folder name) in <game>\Archon\Binaries\Win64\ue4ss\UE4SS.log.
  - Sounds and the intro: the speaker button at the top right (sound on or off, volume, intro on or off).
  - Fonts come from Google Fonts; offline, the panel uses Windows' own font instead.
  - One hit leaves a behemoth at 1 HP after your hit, so the game's own next hit finishes it.
  - Games you host for friends: the server mods (and so these cheats) apply to everyone in your hunts. When you join
    someone else's game, their server decides, so the cheats do nothing there.
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

To turn the game mod off: Dauntless Forever launcher > 1.6.2 > Mods, Lantern Client off.

Licence: AGPL-3.0-only, like Dauntless Forever, whose tools it uses. See LICENSE.
