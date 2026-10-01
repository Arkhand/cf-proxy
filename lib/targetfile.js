"use strict";
/**
 * The .cf-target file: which Cloud Foundry account a project uses.
 *
 * Plain "key = value" lines so the user can read it at a glance. It never holds
 * a password: those live in Windows Credential Manager (credstore.js).
 */
const fs = require("fs");
const path = require("path");

const FILE_NAME = ".cf-target";
const REQUIRED = ["api", "org", "space", "user", "auth"];
const OPTIONAL = ["origin"];
const AUTH_VALUES = ["password", "sso"];

/** Same endpoint written differently (case, trailing slash) is the same region. */
function normalizeApi(api) {
	return String(api || "").trim().replace(/\/+$/, "").toLowerCase();
}

function parseTarget(text, file = FILE_NAME) {
	const out = {};
	String(text).split(/\r?\n/).forEach((raw, i) => {
		const where = `${file}:${i + 1}`;
		// An inline comment needs whitespace before "#", so a "#" inside a value survives.
		const line = raw.replace(/\s+#.*$/, "").trim();
		if (!line || line.startsWith("#")) return;
		const eq = line.indexOf("=");
		if (eq === -1) throw new Error(`${where}: expected "key = value"`);
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		if (!REQUIRED.includes(key) && !OPTIONAL.includes(key)) throw new Error(`${where}: unknown key "${key}"`);
		if (key in out) throw new Error(`${where}: duplicate key "${key}"`);
		if (!value) throw new Error(`${where}: empty value for "${key}"`);
		out[key] = value;
	});
	for (const key of REQUIRED) {
		if (!out[key]) throw new Error(`${file}: missing "${key}"`);
	}
	if (!AUTH_VALUES.includes(out.auth)) {
		throw new Error(`${file}: auth must be ${AUTH_VALUES.join(" or ")}`);
	}
	return out;
}

function isFile(file) {
	try {
		return fs.statSync(file).isFile();
	} catch (e) {
		return false;
	}
}

/** Nearest .cf-target from startDir upward, the way git finds .git. */
function findTargetFile(startDir) {
	let dir = path.resolve(startDir);
	for (;;) {
		const candidate = path.join(dir, FILE_NAME);
		// A file, not just the name: ~/.cf-target is the session store (a directory).
		if (isFile(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function loadTarget(startDir) {
	const file = findTargetFile(startDir);
	if (!file) return null;
	return { file, dir: path.dirname(file), target: parseTarget(fs.readFileSync(file, "utf8"), file) };
}

function formatTarget(target) {
	const keys = [...REQUIRED, ...OPTIONAL].filter((k) => target[k]);
	const width = Math.max(...keys.map((k) => k.length));
	return [
		"# Cloud Foundry account for this project. Used by cf-target, cf-proxy and Claude.",
		"# Not committed (.gitignore). Passwords are NOT here: Windows Credential Manager.",
		...keys.map((k) => `${k.padEnd(width)} = ${target[k]}`),
		""
	].join("\n");
}

function writeTarget(dir, target) {
	const file = path.join(dir, FILE_NAME);
	fs.writeFileSync(file, formatTarget(target), "utf8");
	return file;
}

/** Adds .cf-target to the .gitignore of a git repo. Returns true if it added the line. */
function ensureGitignored(dir) {
	if (!fs.existsSync(path.join(dir, ".git"))) return false;
	const file = path.join(dir, ".gitignore");
	const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	const lines = current.split(/\r?\n/).map((l) => l.trim());
	if (lines.includes(FILE_NAME) || lines.includes(`/${FILE_NAME}`)) return false;
	const sep = current && !current.endsWith("\n") ? "\n" : "";
	fs.writeFileSync(file, `${current}${sep}${FILE_NAME}\n`, "utf8");
	return true;
}

module.exports = {
	FILE_NAME, REQUIRED, AUTH_VALUES, normalizeApi, parseTarget,
	findTargetFile, loadTarget, formatTarget, writeTarget, ensureGitignored
};
