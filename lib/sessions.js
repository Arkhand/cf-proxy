"use strict";
/**
 * Cloud Foundry sessions: one per (API endpoint, user), shared by cf-target and
 * cf-proxy, and a private copy for every run.
 *
 * Why a copy: cf keeps the session AND the target (org/space) in one
 * config.json. Sharing it would make two repos fight over the target, and two
 * cf processes writing it at once is how ~/.cf ends up with corrupt_* backups.
 * Each run works on a temp copy and sets its own target there; only renewed
 * tokens go back, with compare-and-swap, so a concurrent refresh is never lost
 * or half-written.
 *
 * Vendored verbatim into CF-proxy (lib/sessions.js): keep it free of requires
 * outside Node's standard library. test/vendored.test.js checks the copies match.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOKEN_FIELDS = ["AccessToken", "RefreshToken", "UAAGrantType"];
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 10000;

function baseDir() {
	return process.env.CF_TARGET_HOME || path.join(os.homedir(), ".cf-target");
}

function normalizeApi(api) {
	return String(api || "").trim().replace(/\/+$/, "").toLowerCase();
}

/** Readable, filesystem-safe and collision-free: "dev_acme.com-1a2b3c4d". */
function slug(value) {
	const raw = String(value || "").trim().toLowerCase();
	const clean = raw.replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "_";
	return `${clean}-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
}

function sessionHome(api, user) {
	let host;
	try {
		host = new URL(normalizeApi(api)).host;
	} catch (e) {
		host = normalizeApi(api);
	}
	return path.join(baseDir(), "sessions", slug(host), slug(user), "cf-home");
}

function configFile(home) {
	return path.join(home, ".cf", "config.json");
}

function hashFile(file) {
	try {
		return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	} catch (e) {
		return null;
	}
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Short exclusive lock on a session, held only while copying or writing back. */
function lock(sharedHome) {
	const file = path.join(path.dirname(sharedHome), "session.lock");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			fs.closeSync(fs.openSync(file, "wx"));
			return () => {
				try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
			};
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			try {
				// A lock older than any copy could take belongs to a dead process.
				if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) {
					fs.unlinkSync(file);
					continue;
				}
			} catch (_) {
				continue;
			}
			if (Date.now() > deadline) throw new Error(`Session busy: ${file}`);
			sleep(50);
		}
	}
}

/** User inside a UAA access token (a JWT), lowercased; null if it cannot be read. */
function tokenUser(token) {
	try {
		const payload = JSON.parse(Buffer.from(String(token).replace(/^bearer\s+/i, "").split(".")[1], "base64url").toString("utf8"));
		const user = payload.user_name || payload.email || payload.sub;
		return user ? String(user).toLowerCase() : null;
	} catch (e) {
		return null;
	}
}

function writeAtomic(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, text, "utf8");
	fs.renameSync(tmp, file);
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === "EPERM";
	}
}

/**
 * Removes private homes left by processes that died without cleaning up
 * (Ctrl+C, taskkill /F, a tool timeout): they hold live tokens. The pid is in
 * the folder name, so a copy is only removed once its owner is gone.
 */
function sweepOrphans() {
	let entries = [];
	try {
		entries = fs.readdirSync(os.tmpdir());
	} catch (e) {
		return;
	}
	for (const name of entries) {
		const m = name.match(/^cf-target-(\d+)-/);
		if (m && !pidAlive(Number(m[1]))) {
			try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); } catch (e) { /* in use: next time */ }
		}
	}
}

/** Private CF_HOME for one run: a copy of the shared session (or empty). */
function openRun(sharedHome) {
	sweepOrphans();
	const home = fs.mkdtempSync(path.join(os.tmpdir(), `cf-target-${process.pid}-`));
	const release = lock(sharedHome);
	try {
		const shared = configFile(sharedHome);
		if (fs.existsSync(shared)) {
			fs.mkdirSync(path.dirname(configFile(home)), { recursive: true });
			fs.copyFileSync(shared, configFile(home));
		}
		return { home, sharedHome, baseHash: hashFile(shared) };
	} finally {
		release();
	}
}

/**
 * Copies renewed tokens back to the shared session.
 * replace: true (after a login) writes the whole config.
 * Returns "written", "unchanged", or "skipped" (another run wrote first: theirs wins).
 */
function writeBack(run, { replace = false } = {}) {
	let mine;
	try {
		mine = JSON.parse(fs.readFileSync(configFile(run.home), "utf8"));
	} catch (e) {
		return "unchanged";
	}
	const sharedFile = configFile(run.sharedHome);
	const release = lock(run.sharedHome);
	try {
		const current = hashFile(sharedFile);
		if (replace || current === null) {
			writeAtomic(sharedFile, JSON.stringify(mine, null, 2));
			return "written";
		}
		const shared = JSON.parse(fs.readFileSync(sharedFile, "utf8"));
		if (TOKEN_FIELDS.every((k) => shared[k] === mine[k])) return "unchanged";
		if (current !== run.baseHash) return "skipped";
		// A `cf auth`/`cf login` as someone else inside a run must not hand that
		// user's tokens to this user's session.
		const before = tokenUser(shared.AccessToken);
		const after = tokenUser(mine.AccessToken);
		if (before && after && before !== after) return "skipped";
		for (const k of TOKEN_FIELDS) shared[k] = mine[k];
		writeAtomic(sharedFile, JSON.stringify(shared, null, 2));
		return "written";
	} finally {
		release();
	}
}

function closeRun(run) {
	fs.rmSync(run.home, { recursive: true, force: true });
}

module.exports = { TOKEN_FIELDS, baseDir, normalizeApi, sessionHome, configFile, openRun, writeBack, closeRun };
