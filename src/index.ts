// Arqen Census uploader: watches every ArqenCensus.lua under the WoW folders and
// sends it to the server when the game has written a new version (logout or /reload).
// Only reads files on disk; it never touches the game process.
//
// Runs as a Node script in development or as ArqenCensusUploader.exe (Node single
// executable, built by scripts/build-exe.mjs) for scanners. Double-clicking the exe
// (no arguments) runs the guided setup the first time and shows the status after.
//
//   (no arguments)                    guided setup, or status if already set up
//   watch                             watch and upload (what autostart runs)
//   once [--force]                    upload changed files once and exit (--force: all files)
//   setup --server URL --key KEY [--wow "D:\Games\World of Warcraft"]
//   status [--pause]                  show config, found files and the last log lines
//   install                           start hidden at Windows login (Startup folder shortcut)
//   uninstall                         remove autostart and stop the running uploader

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import * as sea from "node:sea";
import { gzipSync } from "node:zlib";

const VERSION = "1.0.1";
const DEFAULT_SERVER = "https://www.forevercensus.com";
const IS_EXE = sea.isSea();
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local"), "ArqenCensus");
const INSTALLED_EXE = path.join(INSTALL_DIR, "ArqenCensusUploader.exe");
const APP_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), ".config"), "ArqenCensus");
const CONFIG_FILE = path.join(APP_DIR, "config.json");
const STATE_FILE = path.join(APP_DIR, "state.json");
const LOG_FILE = path.join(APP_DIR, "uploader.log");
const LOCK_FILE = path.join(APP_DIR, "uploader.pid");
const SHORTCUT = path.join(
  process.env.APPDATA ?? "",
  "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Arqen Census uploader.lnk",
);
const FILE_NAME = "ArqenCensus.lua";
const POLL_MS = 10_000;
const DEFAULT_ROOTS = [
  "C:\\Program Files (x86)\\World of Warcraft",
  "C:\\Program Files\\World of Warcraft",
  "D:\\World of Warcraft",
  "D:\\Games\\World of Warcraft",
  "E:\\World of Warcraft",
];

interface Config {
  server: string;
  key: string;
  wowRoots?: string[];
}

interface State {
  /** File path -> sha256 of the content last accepted by the server. */
  uploaded: Record<string, string>;
  /** File path -> newest scan time the server has; written into the file once WoW is closed. */
  receipts?: Record<string, number>;
}

function log(msg: string): void {
  const line = `${new Date().toLocaleString("sv-SE")} ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // logging must never stop uploads
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Every <root>/_flavor_/WTF/Account/<account>/SavedVariables/ArqenCensus.lua. */
function findFiles(roots: string[]): string[] {
  const out: string[] = [];
  const dirs = (p: string) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  };
  for (const root of roots) {
    for (const flavor of dirs(root).filter((d) => /^_.+_$/.test(d))) {
      const accounts = path.join(root, flavor, "WTF", "Account");
      for (const account of dirs(accounts)) {
        const file = path.join(accounts, account, "SavedVariables", FILE_NAME);
        if (existsSync(file)) out.push(file);
      }
    }
  }
  return out;
}

async function upload(config: Config, state: State, file: string): Promise<void> {
  const content = readFileSync(file);
  const sha = createHash("sha256").update(content).digest("hex");
  if (state.uploaded[file] === sha) return;
  const body = gzipSync(content);
  const res = await fetch(new URL("/api/upload", config.server), {
    method: "POST",
    headers: { authorization: `Bearer ${config.key}`, "content-type": "application/gzip" },
    body,
  });
  const result = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${res.status} ${String(result.error ?? "")}`);
  state.uploaded[file] = sha;
  if (typeof result.latest === "number" && result.latest > 0) (state.receipts ??= {})[file] = result.latest;
  writeJson(STATE_FILE, state);
  log(
    `Uploaded ${short(file)} (${(body.length / 1024).toFixed(0)} KB): ${result.chars} characters, ${result.newChars} new, ${result.scans} scans` +
          (result.rejected ? `, ${result.rejected} rejected ${JSON.stringify(result.reasons)}` : ""),
  );
}

function wowRunning(): boolean {
  try {
    const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    return /^"wow[^"]*\.exe"/im.test(out);
  } catch {
    return true; // unsure: never touch the file
  }
}

/**
 * Tells the addon what the server already has, so it can prune it on the next login.
 * Appends one line to the SavedVariables file, which runs after the table is loaded.
 * Only while WoW is closed: a running game would overwrite the file on its next save.
 */
function writeReceipt(state: State, file: string): void {
  const until = state.receipts?.[file];
  if (!until || wowRunning()) return;
  const content = readFileSync(file);
  if (createHash("sha256").update(content).digest("hex") !== state.uploaded[file]) return; // changed since upload
  const next = Buffer.concat([content, Buffer.from(`\nArqenCensusDB["uploadedUntil"] = ${Math.floor(until)}\n`)]);
  writeFileSync(file, next);
  state.uploaded[file] = createHash("sha256").update(next).digest("hex");
  delete state.receipts![file];
  writeJson(STATE_FILE, state);
  log(`Receipt written: the addon prunes uploaded data up to ${new Date(until * 1000).toLocaleString("sv-SE")} at next login`);
}

const lastError = new Map<string, string>();

const short = (file: string) => file.split(path.sep).slice(-6).join("/");

async function pass(config: Config, state: State, stable: Map<string, string> | null): Promise<void> {
  for (const file of findFiles(config.wowRoots ?? DEFAULT_ROOTS)) {
    try {
      // Wait until the file has looked the same for one poll, so we never read a half-written save.
      if (stable) {
        const s = statSync(file);
        const sig = `${s.mtimeMs}:${s.size}`;
        const prev = stable.get(file);
        stable.set(file, sig);
        if (prev !== sig) continue;
      }
      await upload(config, state, file);
      writeReceipt(state, file);
      lastError.delete(file);
    } catch (e) {
      // Log each new error once, not every poll while the server is down.
      const msg = e instanceof Error ? e.message : String(e);
      if (lastError.get(file) !== msg) log(`Upload failed for ${short(file)}, will retry: ${msg}`);
      lastError.set(file, msg);
    }
  }
}

/** Pid of another live uploader, from the lock file. */
function runningPid(): number | null {
  try {
    // A lock from before the last boot is stale: shutdown skips the cleanup and
    // Windows may hand the same pid to another process.
    const bootedAt = Date.now() - os.uptime() * 1000;
    if (statSync(LOCK_FILE).mtimeMs < bootedAt) return null;
    const pid = Number(readFileSync(LOCK_FILE, "utf8"));
    if (!pid || pid === process.pid) return null;
    process.kill(pid, 0); // throws if no such process
    return pid;
  } catch {
    return null;
  }
}

const CONHOST = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe");

/** What autostart runs: the installed exe, or node with this script in development. */
function watchCommand(): { exe: string; args: string[] } {
  return IS_EXE ? { exe: INSTALLED_EXE, args: ["watch"] } : { exe: process.execPath, args: [process.argv[1], "watch"] };
}

/**
 * Shortcut in the user's Startup folder that runs the uploader without a window.
 * The exe first copies itself to %LOCALAPPDATA%\ArqenCensus, so the download can be deleted.
 */
function installAutostart(): void {
  if (IS_EXE && path.resolve(process.execPath).toLowerCase() !== INSTALLED_EXE.toLowerCase()) {
    const pid = runningPid();
    if (pid) process.kill(pid); // an older copy may be running from the installed file
    mkdirSync(INSTALL_DIR, { recursive: true });
    copyFileSync(process.execPath, INSTALLED_EXE);
  }
  const { exe, args } = watchCommand();
  const quoted = [exe, ...args].map((a) => `"${a}"`).join(" ");
  mkdirSync(path.dirname(SHORTCUT), { recursive: true }); // missing on some fresh or redirected profiles
  const ps = [
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK)",
    "$s.TargetPath = $env:CONHOST",
    "$s.Arguments = '--headless ' + $env:CMDLINE",
    "$s.WorkingDirectory = $env:DIR",
    "$s.Description = 'Arqen Census uploader'",
    "$s.WindowStyle = 7",
    "$s.Save()",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    env: { ...process.env, LNK: SHORTCUT, CONHOST, CMDLINE: quoted, DIR: path.dirname(exe) },
    stdio: "inherit",
  });
}

/**
 * Starts the watcher in the background, without a window, unless one already runs.
 * Spawned directly (windowsHide gives it no console); conhost --headless is only used
 * by the autostart shortcut, where Windows starts it.
 */
function startHidden(): void {
  if (runningPid()) return;
  const { exe, args } = watchCommand();
  spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function printStatus(config: Partial<Config>): void {
  console.log(`Arqen Census uploader ${VERSION}`);
  console.log(`Server: ${config.server ?? "(not set)"}, key: ${config.key ? "set" : "(not set)"}`);
  console.log(`Autostart: ${existsSync(SHORTCUT) ? "on" : "off"}, running: ${runningPid() ? "yes" : "no"}`);
  const files = findFiles(config.wowRoots ?? DEFAULT_ROOTS);
  if (files.length === 0) console.log("No ArqenCensus.lua found yet. Install the addon, scan once and click Save.");
  for (const f of files) console.log(`Found: ${f}`);
  try {
    console.log("\nLast log lines:\n" + readFileSync(LOG_FILE, "utf8").trimEnd().split("\n").slice(-5).join("\n"));
  } catch {
    // no log yet
  }
}

/** WoW install folders: any of the usual places that hold a _classic_-style folder. */
function wowRootsFound(roots: string[]): string[] {
  return roots.filter((r) => {
    try {
      return readdirSync(r, { withFileTypes: true }).some((d) => d.isDirectory() && /^_.+_$/.test(d.name));
    } catch {
      return false;
    }
  });
}

async function checkKey(server: string, key: string): Promise<string | null> {
  const res = await fetch(new URL("/api/scanner/me", server), { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { name?: string };
  return body.name ?? "scanner";
}

/** Double-click: guided setup the first time, then install, start and show the status. */
async function interactive(config: Partial<Config>): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Arqen Census uploader: sends your census scans to forevercensus.com.\n");
  try {
    if (!config.key) {
      const server = config.server ?? DEFAULT_SERVER;
      let name: string | null = null;
      let key = "";
      for (let tries = 0; !name && tries < 3; tries++) {
        key = (await rl.question("Paste your scanner key and press Enter: ")).trim();
        name = key ? await checkKey(server, key).catch(() => null) : null;
        if (!name) console.log("That key was not accepted. Check it and try again (or ask for a new one at forevercensus.com/scanner).");
      }
      if (!name) return;
      console.log(`Key OK, hello ${name}!`);
      let roots = wowRootsFound(DEFAULT_ROOTS);
      if (roots.length === 0) {
        const answer = (await rl.question('Where is World of Warcraft installed? (e.g. D:\\Games\\World of Warcraft): ')).trim().replace(/^"|"$/g, "");
        roots = wowRootsFound([answer]);
        if (roots.length === 0) console.log("No WoW folders found there. Saving it anyway; fix it later with: setup --wow <path>");
        roots = roots.length ? roots : [answer];
      }
      config = { ...config, server, key, wowRoots: roots };
      writeJson(CONFIG_FILE, config);
      console.log(`WoW folder: ${roots.join(", ")}`);
    }
    installAutostart();
    startHidden();
    console.log("\nAll set: the uploader now runs in the background and starts with Windows.");
    console.log("Scan in game, click Save (or log out), and your scans are uploaded within a minute.\n");
    await new Promise((r) => setTimeout(r, 1500));
    printStatus(config);
  } finally {
    await rl.question("\nPress Enter to close.").catch(() => "");
    rl.close();
  }
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd = "", ...args] = process.argv.slice(2);
  const config = readJson<Partial<Config>>(CONFIG_FILE, {});

  if (cmd === "") return interactive(config);

  if (cmd === "setup") {
    const next = { ...config, server: arg(args, "--server") ?? config.server, key: arg(args, "--key") ?? config.key };
    const wow = arg(args, "--wow");
    if (wow) next.wowRoots = [wow];
    writeJson(CONFIG_FILE, next);
    console.log(`Saved ${CONFIG_FILE}`);
    return;
  }

  if (cmd === "status") {
    console.log(`Config: ${CONFIG_FILE}`);
    printStatus(config);
    if (args.includes("--pause")) {
      // Opened from the desktop shortcut: keep the window until a key is pressed.
      console.log("\nPress Enter to close.");
      await new Promise((r) => process.stdin.once("data", r));
      process.exit(0);
    }
    return;
  }

  if (cmd === "install") {
    installAutostart();
    console.log(`Autostart on: the uploader starts hidden when you log in to Windows.\n${SHORTCUT}`);
    return;
  }

  if (cmd === "uninstall") {
    if (existsSync(SHORTCUT)) unlinkSync(SHORTCUT);
    const pid = runningPid();
    if (pid) process.kill(pid);
    console.log("Autostart off, uploader stopped.");
    return;
  }

  if (cmd !== "watch" && cmd !== "once") {
    console.error(`Unknown command "${cmd}". Run without arguments for the guided setup.`);
    process.exit(1);
  }
  if (!config.server || !config.key) {
    console.error("Not set up yet. Run without arguments for the guided setup.");
    process.exit(1);
  }
  const ready = config as Config;
  const state = readJson<State>(STATE_FILE, { uploaded: {} });

  if (cmd === "once") {
    if (args.includes("--force")) state.uploaded = {};
    await pass(ready, state, null);
    return;
  }

  // One watcher at a time, even if autostart and a manual start overlap.
  const other = runningPid();
  if (other) {
    console.log(`Already running (pid ${other}).`);
    return;
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  process.on("exit", () => {
    if (runningPid() === null) rmSync(LOCK_FILE, { force: true });
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));

  log(`Watching for ${FILE_NAME} every ${POLL_MS / 1000}s, uploading to ${ready.server}`);
  const stable = new Map<string, string>();
  for (;;) {
    await pass(ready, state, stable);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
