// Builds dist/ArqenCensusUploader.exe: Node single executable with the uploader inside,
// so scanners don't need Node. Plus a zip of it for download.
//   node scripts/build-exe.mjs
// Steps: TypeScript -> one CommonJS file (TypeScript from ../web), SEA blob with Node's
// own --experimental-sea-config, inject into a copy of this node.exe with postject.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}dist`;
const ts = createRequire(`${root}../web/package.json`)("typescript");

const src = readFileSync(`${root}src/index.ts`, "utf8");
const version = src.match(/const VERSION = "([^"]+)"/)?.[1];
if (!version) throw new Error("No VERSION in src/index.ts");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const { outputText, diagnostics } = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  reportDiagnostics: true,
});
if (diagnostics?.length) throw new Error(ts.formatDiagnostics(diagnostics, { getNewLine: () => "\n", getCurrentDirectory: () => root, getCanonicalFileName: (f) => f }));
writeFileSync(`${dist}/uploader.cjs`, outputText);

writeFileSync(`${dist}/sea-config.json`, JSON.stringify({
  main: `${dist}/uploader.cjs`,
  output: `${dist}/sea-prep.blob`,
  disableExperimentalSEAWarning: true,
}));
execFileSync(process.execPath, ["--experimental-sea-config", `${dist}/sea-config.json`], { stdio: "inherit" });

const exe = `${dist}/ArqenCensusUploader.exe`;
copyFileSync(process.execPath, exe);
execFileSync(process.execPath, [
  `${root}node_modules/postject/dist/cli.js`, exe, "NODE_SEA_BLOB", `${dist}/sea-prep.blob`,
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
], { stdio: "inherit" });

// Windows' own bsdtar (Git's GNU tar earlier in PATH reads "C:" as a host).
const zip = `ArqenCensusUploader-${version}.zip`;
execFileSync(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`, ["-a", "-c", "-f", `${dist}/${zip}`, "-C", dist, "ArqenCensusUploader.exe"], { stdio: "inherit" });
console.log(`Built ${exe} and dist/${zip}`);
