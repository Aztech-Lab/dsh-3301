#!/usr/bin/env node
/**
 * deploy.mjs — deploy this project into a DSH profile as a bundle.
 *
 * Why a copy instead of a junction: Node resolves a module's own bare imports
 * from its **real** path, so a linked copy on another drive would no longer find
 * the harness packages (they resolve through `$DSH_HOME/profiles/node_modules`).
 *
 * Usage:
 *   node tools/deploy.mjs [bundleName] [profileDir]
 * Defaults: bundleName `dsh-3301`, profileDir `$DSH_HOME/profiles/web`.
 *
 * The script owns every deployment-time rename: the deployed manifest takes the
 * bundle name, the bundle patch's row name is rewritten to match, and the
 * client ModuleLoader id is rewritten to the same string. A profile resolves
 * the client half by package name, so those three must stay identical.
 *
 * A leftover `dsh-3301-gate` install (the previous default name) is removed
 * from the profile so it cannot keep the GUI from loading.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bundleName = process.argv[2] ?? "dsh-3301";
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const profileDir = process.argv[3] ?? path.join(dshHome, "profiles", "web");
const sourceDir = path.resolve(import.meta.dirname, "..");
const targetDir = path.join(profileDir, "node_modules", bundleName);
const sourcePackageName = "dsh-3301";
const retiredNames = ["dsh-3301-gate"];

const LIB_FILES = [
	"plugin.js",
	"client.js",
	"gate-auth.js",
	"client-bootstrap.js",
	"index.js",
	"cli.js",
	"dsh-session.js",
];

function fail(message) {
	console.error(`deploy: ${message}`);
	process.exit(1);
}

/** Read JSON tolerating a UTF-8 BOM (editors on Windows add one readily). */
function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

if (!fs.existsSync(profileDir)) fail(`profile not found: ${profileDir}`);
if (!fs.existsSync(path.join(sourceDir, "lib", "plugin.js"))) fail(`not the dsh-3301 project: ${sourceDir}`);

fs.mkdirSync(path.join(targetDir, "lib"), { recursive: true });
fs.mkdirSync(path.join(targetDir, "tools"), { recursive: true });

// Manifest: keep every field, only the package name changes.
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8"));
manifest.name = bundleName;
delete manifest.devDependencies;
fs.writeFileSync(path.join(targetDir, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

// Bundle patch: the insert row must name this deployment.
const patch = fs
	.readFileSync(path.join(sourceDir, "cordis.patch.yml"), "utf8")
	.replaceAll(`name: '${sourcePackageName}'`, `name: '${bundleName}'`)
	.replaceAll(`name: "${sourcePackageName}"`, `name: "${bundleName}"`);
if (!patch.includes(`name: '${bundleName}'`)) fail("cordis.patch.yml has no insert row to rename");
fs.writeFileSync(path.join(targetDir, "cordis.patch.yml"), patch);

for (const file of LIB_FILES) {
	const from = path.join(sourceDir, "lib", file);
	if (!fs.existsSync(from)) fail(`missing source file: ${from}`);
	fs.copyFileSync(from, path.join(targetDir, "lib", file));
}
for (const tool of ["check.mjs", "check-gate.mjs", "probe.mjs", "soak.mjs", "dry-run-plugin.mjs"]) {
	const from = path.join(sourceDir, "tools", tool);
	if (fs.existsSync(from)) fs.copyFileSync(from, path.join(targetDir, "tools", tool));
}

// Client ModuleLoader id must equal the package name the profile asks for.
const clientPath = path.join(targetDir, "lib", "client.js");
const client = fs.readFileSync(clientPath, "utf8");
const rewrittenClient = client.replace(
	/window\.__ModuleLoader__\.load\(\{\s*id:\s*"[^"]+"/,
	`window.__ModuleLoader__.load({\n\tid: "${bundleName}"`,
);
if (!rewrittenClient.includes(`id: "${bundleName}"`)) fail("client.js has no ModuleLoader id to rewrite");
if (rewrittenClient !== client) fs.writeFileSync(clientPath, rewrittenClient);

// Profile manifest: the bundle must be listed (client halves are collected from bundles).
const profileManifestPath = path.join(profileDir, "package.json");
const profile = readJson(profileManifestPath);
const bundles = profile.dsh?.profile?.bundles ?? [];
let manifestChanged = false;
if (!bundles.includes(bundleName)) {
	bundles.push(bundleName);
	profile.dsh.profile.bundles = bundles;
	manifestChanged = true;
}
if (!profile.dependencies?.[bundleName]) {
	profile.dependencies = { ...(profile.dependencies ?? {}), [bundleName]: `file:./node_modules/${bundleName}` };
	manifestChanged = true;
}
for (const retired of retiredNames) {
	if (retired === bundleName) continue;
	const at = bundles.indexOf(retired);
	if (at >= 0) {
		bundles.splice(at, 1);
		profile.dsh.profile.bundles = bundles;
		manifestChanged = true;
	}
	if (profile.dependencies?.[retired] !== undefined) {
		delete profile.dependencies[retired];
		manifestChanged = true;
	}
	const retiredDir = path.join(profileDir, "node_modules", retired);
	if (fs.existsSync(retiredDir)) {
		fs.rmSync(retiredDir, { recursive: true, force: true });
		console.log(`deploy: removed leftover ${retired}`);
	}
}
if (manifestChanged) fs.writeFileSync(profileManifestPath, `${JSON.stringify(profile, null, 2)}\n`);

console.log(`deploy: ${sourceDir} -> ${targetDir}`);
console.log(`deploy: bundle "${bundleName}" ${manifestChanged ? "registered in the profile manifest" : "already registered"}`);
console.log("deploy: restart the DSH web app (or re-run this after it reloads) for a bundle-list change to compose");
