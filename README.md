# Lantern Client

Trainer for Dauntless Forever that works (formerly DF Trainer).

A companion panel for [Dauntless Forever](https://github.com/addison2k/DauntlessForever) (Dauntless 1.6.2): cheats, an item giver that works while you play, and game rules. Created by Alex, powered by Claude.

**Players:** download `Lantern-Client-Setup.exe` from the [latest release](../../releases/latest) and run it, then paste the key you were given. It installs, opens, and keeps itself up to date. See `app/README.txt`.

## How it fits together

| Folder | What it is |
|---|---|
| `app/` | The panel: `server.js` (local server), `keys.js` (keys), `live.js` (gifts while the game runs), `ui/index.html`, the UE4SS game mod, `release.json` (version, notes, update channel) |
| `launcher/` | `Lantern Client.exe`, written in Go (standard library only): installer, launcher, updater and uninstaller in one |
| `tools/build.mjs` | Builds a release into `dist/`: the app zip, the launcher exe carrying it, and the signed manifest |
| `tools/keygen.mjs` | Makes the release signing key (once per project) |
| `licenses/revoked.txt` | Revoked key ids, one per line. Clients read it at start and every few hours |
| `.github/workflows/release.yml` | Publishes a release whenever `app/release.json` gets a new version on `main` |

## Releasing a new version

1. Change what you need in `app/` (or `launcher/`).
2. Raise `version` in `app/release.json` and write one or two sentences in `notes`. Players see the notes when the update arrives.
   If the launcher itself changed, also raise `launcher/VERSION`.
3. Push to `main`. The workflow builds, signs and publishes `vX.Y.Z`. Every installed copy picks it up the next time it opens, or within a few hours while it runs (with a one-click restart).

A push without a version change does not release anything.

## One-time set-up

1. Make this a **public** GitHub repository (the launcher reads releases without logging in) and push it.
2. Add the secret: *Settings > Secrets and variables > Actions > New repository secret*, name `DFT_RELEASE_KEY`, value: the whole content of `release-key.pem`.
3. Keep `release-key.pem` somewhere safe and private. It is the only key installed launchers accept: lose it and they can no longer be updated; leak it and someone else could sign updates. It is never committed (`.gitignore`).

The update channel is the repository the workflow runs in (`GITHUB_REPOSITORY`), unless `repo` in `app/release.json` names another.

## How updates stay safe

- Each release has `dftrainer-manifest.json`: version, notes, and for the app zip and the launcher exe their file name, size and SHA-256, all signed with Ed25519 (`dftrainer-release-v1` message, see `launcher/update.go`).
- The launcher has the public key built in (`launcher/release-public-key.txt`). It installs nothing whose signature or checksums do not match.
- New versions unpack into their own folder (`app\<version>`, via a temporary folder) and become current only once complete. The previous version is kept.
- If a new version does not start, the launcher goes back to the previous one and never retries that version.
- The launcher can replace itself (a running exe can be renamed on Windows, not overwritten).

## Antivirus and code signing

The launcher avoids what antivirus heuristics flag in small unsigned tools: no PowerShell, `reg.exe`, `cmd` or `rundll32` (shortcuts, the Apps & features entry, uninstalling and opening links go through the Windows API), no scripts in the app package, and the exe keeps its symbol table. An unsigned exe can still be flagged by Windows Defender's machine-learning check; the lasting fix is an Authenticode signature. The workflow signs the exe when two repository secrets exist: `SIGN_PFX_BASE64` (the code-signing certificate as a base64 .pfx) and `SIGN_PASS` (its password).

## Keys

Keys are signed with the owner key (Ed25519, separate from the release key) and checked offline by `app/keys.js` against the public half built into it. A key holds an id, a name, when it was made and when it runs out (or never). The owner imports `lantern-owner-key.pem` in the client to get the Keys page, which makes, lists and revokes keys. Revoking means adding the key id to `licenses/revoked.txt` here. Without a valid key the panel answers only the key screen, settings and updates, and tells the game mod to stay off.

The owner key is never committed (`.gitignore`). This repository is public and the code is AGPL, so the check keeps keys from being shared around; it is not tamper-proof against someone who edits the source.

## Renamed from DF Trainer

Installs from before the rename keep working: the manifest name (`dftrainer-manifest.json`) and its signature prefix are unchanged, the panel still prints the line older launchers look for, and the new launcher, started under its old name `DF Trainer.exe`, moves itself to `Lantern Client.exe` and swaps the shortcuts. The install folder (`%LOCALAPPDATA%\DFTrainer`), the Apps & features key and the game mod's folder keep their old names so nothing is lost.

## Building by hand

```
node tools/build.mjs --key release-key.pem --repo owner/name
```

Needs Go 1.24+ and Node 22+. Output goes to `dist/`. `--goos linux` builds a Linux launcher for testing the update logic (the panel itself is Windows-only).

## Licence

AGPL-3.0-only, like Dauntless Forever, whose tools it drives.
