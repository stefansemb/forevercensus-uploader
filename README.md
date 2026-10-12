# Forever Census uploader

Small Windows app that sends your **Arqen Census** addon scans to [forevercensus.com](https://www.forevercensus.com), the fan-made population census for World of Warcraft: Forever.

## Install

1. Get a personal scanner key at [forevercensus.com/scanner](https://www.forevercensus.com/scanner) and install the **Arqen Census** addon.
2. Download **[ArqenCensusUploader.zip](https://github.com/stefansemb/forevercensus-uploader/releases/latest/download/ArqenCensusUploader.zip)**, unzip it and double-click `ArqenCensusUploader.exe`.
3. Paste your key. The app finds your WoW folder, installs itself to `%LOCALAPPDATA%\ArqenCensus`, starts with Windows and runs in the background.

Double-click it again any time to see the status and the last uploads.

**"Windows protected your PC"?** The app is not code-signed (a certificate costs more than this hobby project earns), so Windows SmartScreen warns the first time. Click **More info** and **Run anyway**. The full source is in this repo.

## What it does, and what it doesn't

- Every 10 seconds it checks `WTF\Account\*\SavedVariables\ArqenCensus.lua` in your WoW folders. When the game has saved a new version (after `/reload` or logging out) it uploads that file, gzipped, with your key.
- When WoW is closed, it adds one line to that file telling the addon what is already uploaded, so the addon can clean up its saved data.
- It **never touches the game process**, reads no other files and sends nothing else.
- Settings and a log are in `%APPDATA%\ArqenCensus`.

## Commands

Run from a terminal: `ArqenCensusUploader.exe <command>`

| Command | |
|---|---|
| *(none)* | Guided setup the first time, then status |
| `status` | Settings, files found, last log lines |
| `uninstall` | Remove autostart and stop the uploader |
| `once --force` | Upload all files once now |

## Build

`src/index.ts` is the whole app (Node 24, no dependencies). `scripts/build-exe.mjs` turns it into a Node [single executable application](https://nodejs.org/api/single-executable-applications.html) (needs TypeScript and `postject`).

Fan-made, not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard Entertainment.
