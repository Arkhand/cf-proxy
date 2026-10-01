/**
 * PASO 0b - Registro de corridas: que proxies estan vivos, en que puerto, de
 * que perfil.
 *
 * Por que existe: se puede arrancar cf-proxy desde la ventana, desde una
 * terminal, o desde una IA en otro chat. Todos tienen que ver lo mismo y no
 * levantar dos veces el mismo perfil. El registro es un archivo por perfil en
 * ~/.cf-proxy/runs/<perfil>.json, y es a la vez el LOCK: se crea con 'wx'
 * (falla si ya existe), asi que de dos arranques simultaneos gana uno solo.
 *
 * Un registro de un proceso que ya no existe (se corto la luz, taskkill) se
 * detecta por pid y se reclama. Para no confundir un pid reciclado por
 * Windows con el proxy, se exige ademas que el proceso sea `node`, y el
 * health exige que el proxy responda con su propio perfil y pid.
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");
const profiles = require("./profiles");

/** Codigos de salida compartidos por server.js y la consola. */
// NO_RESOURCES: el space no tiene `destination` usable (la ventana ofrece desplegar el MTA).
// MISMATCH: la sesion o el proyecto (.cf-target) son de otra cuenta que el perfil.
const EXIT = { ERROR: 1, USAGE: 2, BUSY: 3, NO_SESSION: 4, PORT_BUSY: 5, NO_RESOURCES: 6, MISMATCH: 7 };

function runsDir() {
	return path.join(profiles.baseDir(), "runs");
}

function recordFile(name) {
	return path.join(runsDir(), `${name}.json`);
}

function logFile(name) {
	return path.join(runsDir(), `${name}.log`);
}

function read(name) {
	try {
		return JSON.parse(fs.readFileSync(recordFile(name), "utf8"));
	} catch (e) {
		return null;
	}
}

/** Escritura atomica: quien lee nunca ve un JSON a medio escribir. */
function write(name, record) {
	const tmp = `${recordFile(name)}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
	fs.renameSync(tmp, recordFile(name));
}

/** El proceso existe. EPERM tambien: existe, pero es de otro usuario. */
function pidAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === "EPERM";
	}
}

/**
 * El pid existe Y es un node. Windows recicla pids rapido: sin este chequeo,
 * un registro viejo podria apuntar a cualquier otro programa, y `stop` lo
 * mataria.
 */
function isAlive(record) {
	if (!record || !pidAlive(record.pid)) return false;
	if (process.platform !== "win32") return true;
	try {
		const out = execFileSync("tasklist", ["/FI", `PID eq ${record.pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, encoding: "utf8" });
		return /node/i.test(out);
	} catch (e) {
		return true;
	}
}

function isFresh(file) {
	try {
		return Date.now() - fs.statSync(file).mtimeMs < 5000;
	} catch (e) {
		return false;
	}
}

/**
 * Toma el lock del perfil. Devuelve {busy:true, record} si otro proceso vivo
 * ya lo tiene; si no, {busy:false, update, release}.
 */
function acquire(name, info = {}) {
	fs.mkdirSync(runsDir(), { recursive: true });

	for (let attempt = 0; attempt < 2; attempt++) {
		let fd;
		try {
			fd = fs.openSync(recordFile(name), "wx");
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
			const existing = read(name);
			if (existing && isAlive(existing)) {
				return { busy: true, record: existing };
			}
			// Ilegible y recien creado: el ganador de la carrera lo esta escribiendo.
			if (!existing && isFresh(recordFile(name))) {
				return { busy: true, record: null };
			}
			// Registro de un proceso muerto: se reclama y se reintenta una vez.
			try { fs.unlinkSync(recordFile(name)); } catch (_) { /* otro lo reclamo antes */ }
			continue;
		}

		const record = { v: 1, profile: name, pid: process.pid, state: "starting", startedAt: new Date().toISOString(), ...info };
		fs.writeSync(fd, JSON.stringify(record, null, 2));
		fs.closeSync(fd);

		return {
			busy: false,
			update(patch) {
				const current = read(name);
				if (current && current.pid === process.pid) write(name, { ...current, ...patch });
			},
			release() {
				const current = read(name);
				if (current && current.pid === process.pid) {
					try { fs.unlinkSync(recordFile(name)); } catch (_) { /* ya no estaba */ }
				}
			}
		};
	}

	const existing = read(name);
	return { busy: true, record: existing };
}

/** Corridas vivas. Los registros de procesos muertos se borran al pasar. */
function list() {
	let files = [];
	try {
		files = fs.readdirSync(runsDir()).filter((f) => f.endsWith(".json"));
	} catch (e) {
		return [];
	}
	const out = [];
	for (const f of files) {
		const record = read(path.basename(f, ".json"));
		if (!record) continue;
		if (isAlive(record)) {
			out.push(record);
		} else {
			try { fs.unlinkSync(path.join(runsDir(), f)); } catch (_) { /* carrera con otro list */ }
		}
	}
	return out.sort((a, b) => a.port - b.port);
}

/** GET /__health del proxy. Solo vale si responde el proxy de ESTE registro. */
function health(record, timeout = 1500) {
	return new Promise((resolve) => {
		const req = http.get({ host: "127.0.0.1", port: record.port, path: "/__health", timeout }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => {
				try {
					const h = JSON.parse(body);
					resolve(h.profile === record.profile && h.pid === record.pid ? h : null);
				} catch (e) {
					resolve(null);
				}
			});
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(null));
	});
}

/** ok = responde; starting = todavia arrancando; down = vivo pero no responde. */
async function status(record) {
	const h = await health(record);
	if (h) return { status: "ok", health: h };
	return { status: record.state === "starting" ? "starting" : "down", health: null };
}

/**
 * Corta la corrida con todos sus hijos. El arbol importa: node abre un
 * `cf ssh` para el tunel, y si queda huerfano sigue ocupando el puerto. El
 * tunel se mata tambien aparte por si node ya habia muerto (sin padre, /T no
 * lo encuentra).
 */
function killTree(record) {
	for (const pid of [record.pid, record.tunnelPid].filter(Boolean)) {
		if (!pidAlive(pid)) continue;
		try {
			if (process.platform === "win32") {
				execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			} else {
				process.kill(pid, "SIGTERM");
			}
		} catch (e) {
			// Ya habia terminado entre el chequeo y el kill.
		}
	}
}

module.exports = { EXIT, runsDir, recordFile, logFile, read, acquire, list, health, status, killTree, isAlive, pidAlive };
