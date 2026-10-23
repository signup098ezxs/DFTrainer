# DF Trainer

Trainer for Dauntless Forever that works.

A trainer panel for [Dauntless Forever](https://github.com/addison2k/DauntlessForever) (Dauntless 1.6.2): cheats, an item giver that works while you play, and game rules. Created by Alex, powered by Claude.

**Players:** download `DF-Trainer-Setup.exe` from the [latest release](../../releases/latest) and run it. It installs, opens, and keeps itself up to date. See `app/README.txt`.

## How it fits together

| Folder | What it is |
|---|---|
| `app/` | The panel: `server.js` (local server), `live.js` (gifts while the game runs), `ui/index.html`, the UE4SS game mod, `release.json` (version, notes, update channel) |
| `launcher/` | `DF Trainer.exe`, written in Go (standard library only): installer, launcher, updater and uninstaller in one |
| `tools/build.mjs` | Builds a release into `dist/`: the app zip, the launcher exe carrying it, and the signed manifest |
| `tools/keygen.mjs` | Makes the release signing key (once per project) |
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

## Building by hand

```
node tools/build.mjs --key release-key.pem --repo owner/name
```

Needs Go 1.24+ and Node 22+. Output goes to `dist/`. `--goos linux` builds a Linux launcher for testing the update logic (the panel itself is Windows-only).

## Licence

AGPL-3.0-only, like Dauntless Forever, whose tools it drives.
