#!/usr/bin/env node
/**
 * cf-proxy - consola de administracion.
 *
 * Arranca, lista y detiene proxies, siempre desde un perfil guardado (una
 * subcuenta de cliente). Las corridas quedan en segundo plano y registradas
 * en ~/.cf-proxy/runs, asi que cualquier terminal, la ventana del launcher o
 * una IA en otro chat ven lo mismo, y `start` de un perfil que ya corre
 * devuelve su URL en vez de levantarlo otra vez.
 *
 * Con --json cada comando imprime UN objeto JSON ({ok:true,...} o
 * {ok:false, code, error}): es lo que usan el launcher y las skills.
 *
 * Comandos:
 *   profiles list
 *   profiles add --name N --api URL --org O --space S [--title T] [--user U]
 *                [--auth sso|password] [--port N|auto] [--tunnel] [--login]
 *                [--create-keys] [--no-open]
 *   profiles edit <p> [mismos flags]          (el nombre no se cambia)
 *   profiles save                              alta o edicion con el JSON por stdin (launcher)
 *   profiles remove <p>
 *   login <p>                                  login interactivo en el CF_HOME del perfil
 *         [--sso-passcode X | --password-stdin]
 *   targets <p>                                orgs/spaces que ve la sesion del perfil
 *   start <p> [--no-open] [--timeout 180]      arranca en segundo plano (idempotente)
 *   stop <p>
 *   ps                                         corridas vivas: titulo, usuario, org/space, puerto, health
 *   status [<p>]                               igual que ps, o una sola
 *   logs <p> [-f]
 *   cf <p> -- <args de cf>                     `cf` con la sesion del perfil (deploy, undeploy...)
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const cf = require("../lib/cf");
const profiles = require("../lib/profiles");
const runs = require("../lib/runs");

const SERVER = process.env.CF_PROXY_SERVER || path.join(__dirname, "..", "server.js");
const { EXIT } = runs;

// ============================================================================
// Argumentos: posicionales, --flag valor, --flag, --no-flag. Todo lo que va
// despues de `--` pasa intacto (para `cf <p> -- ...`).
// ============================================================================
const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
const rest = dashdash === -1 ? [] : argv.slice(dashdash + 1);

const positional = [];
const flags = {};
for (let i = 0; i < own.length; i++) {
	const a = own[i];
	if (a === "-f") {
		flags.follow = true;
	} else if (a.startsWith("--no-")) {
		flags[a.slice(5)] = false;
	} else if (a.startsWith("--")) {
		const next = own[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags[a.slice(2)] = next;
			i++;
		} else {
			flags[a.slice(2)] = true;
		}
	} else {
		positional.push(a);
	}
}
const JSON_OUT = flags.json === true;

// ============================================================================
// Salida: humana o JSON, con codigos de salida estables
// ============================================================================
function done(payload, human) {
	if (JSON_OUT) {
		console.log(JSON.stringify({ ok: true, ...payload }));
	} else if (human) {
		human();
	}
	process.exit(0);
}

function die(code, error, extra = {}) {
	if (JSON_OUT) {
		console.log(JSON.stringify({ ok: false, code, error, ...extra }));
	} else {
		console.error(`ERROR: ${error}`);
		if (extra.hint) console.error(extra.hint);
		if (extra.tail) console.error("\n--- ultimas lineas del log ---\n" + extra.tail);
	}
	process.exit(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readStdin() {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c) => (data += c));
		process.stdin.on("end", () => resolve(data));
	});
}

/** Perfil existente o corte con USAGE. `strict`: ademas tiene que poder arrancar. */
function requireProfile(name, strict) {
	if (!name) die(EXIT.USAGE, "Falta el nombre del perfil.", { hint: "Ver: cf-proxy profiles list" });
	const p = profiles.get(name);
	if (!p) die(EXIT.USAGE, `No existe el perfil ${name}.`, { hint: "Ver: cf-proxy profiles list" });
	if (strict && p.problems.length) {
		die(EXIT.USAGE, `El perfil ${name} no puede arrancar: ${p.problems.join("; ")}.`, { problems: p.problems });
	}
	return p;
}

function tailLines(file, count = 20) {
	try {
		return fs.readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-count).join("\n");
	} catch (e) {
		return "";
	}
}

// ============================================================================
// profiles
// ============================================================================
/** Flags de la linea de comandos -> campos del perfil. Solo los que vinieron. */
function profileFields() {
	const out = {};
	for (const k of ["name", "title", "api", "user", "auth", "org", "space"]) {
		if (typeof flags[k] === "string") out[k] = flags[k];
	}
	if (flags.port !== undefined) out.port = flags.port === "auto" ? "auto" : Number(flags.port);
	const f = {};
	if (flags.tunnel !== undefined) f.tunnel = flags.tunnel !== false;
	if (flags.login !== undefined) f.login = flags.login !== false;
	if (flags["create-keys"] !== undefined) f.create_keys = flags["create-keys"] !== false;
	if (flags.open !== undefined) f.open_browser = flags.open !== false;
	if (Object.keys(f).length) out.flags = f;
	return out;
}

async function cmdProfiles() {
	const sub = positional[1] || "list";
	try {
		if (sub === "list") {
			const list = profiles.load();
			return done({ profiles: list }, () => {
				if (!list.length) return console.log("No hay perfiles. Crear uno: cf-proxy profiles add --name ... --api ... --org ... --space ...");
				for (const p of list) {
					const mark = p.problems.length ? "  !! " + p.problems.join("; ") : "";
					console.log(`${p.name.padEnd(16)} ${String(p.port).padEnd(6)} ${p.org} / ${p.space}  (${p.title})${mark}`);
				}
			});
		}
		if (sub === "add") {
			const p = profiles.add(profileFields());
			return done({ profile: p }, () => console.log(`Perfil ${p.name} creado en el puerto ${p.port}. Siguiente: cf-proxy login ${p.name}`));
		}
		if (sub === "edit") {
			const p = profiles.edit(requireProfile(positional[2]).name, profileFields());
			return done({ profile: p }, () => console.log(`Perfil ${p.name} actualizado (puerto ${p.port}).`));
		}
		if (sub === "save") {
			// Alta o edicion de un perfil completo, con el JSON por stdin (el launcher).
			const input = JSON.parse(await readStdin());
			const exists = profiles.load().some((o) => o.name === input.name);
			const p = exists ? profiles.edit(input.name, input) : profiles.add(input);
			return done({ profile: p, created: !exists });
		}
		if (sub === "remove") {
			const p = requireProfile(positional[2]);
			const record = runs.read(p.name);
			if (record && runs.isAlive(record)) {
				die(EXIT.BUSY, `El perfil ${p.name} esta corriendo. Detenerlo primero: cf-proxy stop ${p.name}`);
			}
			profiles.remove(p.name);
			return done({ removed: p.name }, () => console.log(`Perfil ${p.name} borrado (y su sesion de cf).`));
		}
	} catch (e) {
		die(EXIT.USAGE, e.message);
	}
	die(EXIT.USAGE, `Subcomando desconocido: profiles ${sub}`);
}

// ============================================================================
// login / targets
// ============================================================================
async function cmdLogin() {
	const p = requireProfile(positional[1], false);
	cf.configure({ cfHome: profiles.cfHomeOf(p.name) });
	const withTarget = p.org && p.space ? { org: p.org, space: p.space } : {};
	let failure = null;

	if (typeof flags["sso-passcode"] === "string") {
		const res = await cf.login({ api: p.api, passcode: flags["sso-passcode"], ...withTarget });
		if (!res.ok) die(EXIT.NO_SESSION, res.error);
	} else if (flags["password-stdin"]) {
		const password = (await readStdin()).replace(/\r?\n$/, "");
		const res = await cf.login({ api: p.api, user: p.user, password, ...withTarget });
		if (!res.ok) die(EXIT.NO_SESSION, res.error);
	} else {
		// Interactivo: `cf` pide lo que falte (contrasena, passcode SSO) en esta terminal.
		const args = ["login", "-a", p.api];
		if (p.auth === "sso") args.push("--sso");
		else if (p.user) args.push("-u", p.user);
		if (withTarget.org) args.push("-o", withTarget.org, "-s", withTarget.space);
		const code = await cf.passthrough(args);
		// Con un org inexistente `cf login` sale con error pero deja la sesion: se mira abajo.
		if (code !== 0) failure = `cf login termino con codigo ${code}.`;
	}

	// Se verifica lo que quedo, no lo que se pidio: el login pudo quedar en otro
	// org, o en ninguno si el del perfil no existe para este usuario.
	const session = await cf.checkLogin();
	if (!session.ok) die(EXIT.NO_SESSION, failure || "El login no dejo sesion.");

	// La sesion sirve igual: con ella se listan los orgs reales (`targets`) para
	// corregir el perfil. El arranque igual se niega si el org no existe.
	const warning = p.org && session.org !== p.org
		? `Login OK, pero el org ${p.org} del perfil no existe para ${session.user} en ${p.api}. Elegir el org correcto (cf-proxy targets ${p.name}).`
		: null;
	done({ profile: p.name, user: session.user, api: session.api, org: session.org, space: session.space, warning },
		() => {
			console.log(`OK  ${p.name}: ${session.user} -> ${session.org || "?"} / ${session.space || "?"}`);
			if (warning) console.log(`!!  ${warning}`);
		});
}

async function cmdTargets() {
	const p = requireProfile(positional[1], false);
	cf.configure({ cfHome: profiles.cfHomeOf(p.name) });
	const session = await cf.checkLogin();
	if (!session.ok) die(EXIT.NO_SESSION, `El perfil ${p.name} no tiene sesion.`, { hint: `cf-proxy login ${p.name}` });
	const targets = await cf.listTargets();
	done({ targets, current: { org: session.org, space: session.space, user: session.user } }, () => {
		for (const t of targets) console.log(`${t.org}: ${t.spaces.join(", ")}`);
	});
}

// ============================================================================
// start / stop
// ============================================================================
/** Espera a que la corrida registrada responda. null si no llega a tiempo. */
async function waitHealthy(name, deadline) {
	while (Date.now() < deadline) {
		const record = runs.read(name);
		if (record && record.state === "listening" && (await runs.health(record))) {
			return record;
		}
		await sleep(500);
	}
	return null;
}

async function cmdStart() {
	const p = requireProfile(positional[1], true);
	const deadline = Date.now() + Number(flags.timeout || 180) * 1000;
	const result = (record, already) => done(
		{ already, profile: p.name, url: record.url, port: record.port, pid: record.pid, log: record.log },
		() => console.log(`${already ? "Ya estaba corriendo" : "OK"}  ${p.title}: ${record.url}  (pid ${record.pid})`)
	);

	// Idempotente: si ya corre, se devuelve esa corrida.
	const existing = runs.read(p.name);
	if (existing && runs.isAlive(existing)) {
		const healthy = await waitHealthy(p.name, deadline);
		if (healthy) return result(healthy, true);
		die(EXIT.BUSY, `El perfil ${p.name} tiene un proceso vivo (pid ${existing.pid}) que no responde.`,
			{ hint: `Detenerlo: cf-proxy stop ${p.name}`, tail: tailLines(runs.logFile(p.name)) });
	}

	// Segundo plano: proceso desacoplado, salida a archivo. Sobrevive a esta terminal.
	fs.mkdirSync(runs.runsDir(), { recursive: true });
	const logPath = runs.logFile(p.name);
	const fd = fs.openSync(logPath, "w");
	const args = [SERVER, "--profile", p.name, "--origin", flags.origin || "cli", "--log", logPath];
	if (flags.open === false) args.push("--no-open");

	const child = spawn(process.execPath, args, {
		cwd: path.dirname(SERVER),
		detached: true,
		windowsHide: true,
		stdio: ["ignore", fd, fd]
	});
	fs.closeSync(fd);

	let exitCode = null;
	child.on("exit", (code) => (exitCode = code === null ? EXIT.ERROR : code));
	child.unref();

	while (Date.now() < deadline) {
		if (exitCode === EXIT.BUSY) {
			// Otro `start` gano la carrera: se espera a ese.
			const winner = await waitHealthy(p.name, deadline);
			if (winner) return result(winner, true);
			break;
		}
		if (exitCode !== null) {
			die(exitCode, `cf-proxy (${p.name}) termino al arrancar.`, { tail: tailLines(logPath), log: logPath });
		}
		const record = runs.read(p.name);
		if (record && record.pid === child.pid && record.state === "listening" && (await runs.health(record))) {
			return result(record, false);
		}
		await sleep(500);
	}
	die(EXIT.ERROR, `cf-proxy (${p.name}) no respondio a tiempo. Sigue arrancando en segundo plano.`,
		{ hint: `Ver: cf-proxy logs ${p.name}`, tail: tailLines(logPath), log: logPath });
}

async function cmdStop() {
	const p = requireProfile(positional[1], false);
	const record = runs.read(p.name);
	if (!record || !runs.isAlive(record)) {
		runs.list(); // limpia el registro muerto, si habia
		return done({ profile: p.name, wasRunning: false }, () => console.log(`${p.name} no estaba corriendo.`));
	}

	runs.killTree(record);
	for (let i = 0; i < 10 && runs.pidAlive(record.pid); i++) {
		await sleep(500);
	}
	// taskkill /F no deja correr el handler de salida: el registro se borra aca.
	const after = runs.read(p.name);
	if (after && after.pid === record.pid) {
		try { fs.unlinkSync(runs.recordFile(p.name)); } catch (e) { /* ya no estaba */ }
	}
	done({ profile: p.name, wasRunning: true, pid: record.pid }, () => console.log(`${p.name} detenido (pid ${record.pid}).`));
}

// ============================================================================
// ps / status / logs
// ============================================================================
/**
 * Estado del login de usuario (XSUAA) de una corrida, para avisar que falta
 * ANTES de que una destination PrincipalPropagation/UserTokenExchange falle.
 * null si el proxy todavia no responde.
 */
function describeLogin(record, health) {
	if (!health || !health.login) return null;
	const l = health.login;
	return {
		configured: Boolean(l.configured),
		loggedIn: Boolean(l.loggedIn),
		user: l.user ? l.user.email || l.user.name : null,
		expiresAt: l.expiresAt || null,
		url: l.configured ? `http://localhost:${record.port}${l.loginPath || "/__login"}` : null,
		// Sin XSUAA propio no hay login posible; con puerto fuera de las redirect-uris, va a fallar.
		warning: !l.configured ? l.reason || "Sin XSUAA propio en el space." : profiles.checkXsuaaPort(record.port)
	};
}

/** Texto corto del login para la tabla de `ps`. */
function loginLabel(login) {
	if (!login) return "?";
	if (!login.configured) return "no disponible";
	if (login.loggedIn) return login.user || "si";
	return login.warning ? "FALTA (puerto sin redirect)" : "FALTA";
}

async function describeRuns(only) {
	const list = runs.list().filter((r) => !only || r.profile === only);
	return Promise.all(list.map(async (r) => {
		const s = await runs.status(r);
		return {
			profile: r.profile,
			title: r.title,
			user: r.user,
			api: r.api,
			org: r.org,
			space: r.space,
			port: r.port,
			url: r.url,
			pid: r.pid,
			origin: r.origin,
			startedAt: r.startedAt,
			log: r.log,
			status: s.status,
			onPremise: s.health ? s.health.onPremise : null,
			login: describeLogin(r, s.health)
		};
	}));
}

async function cmdPs() {
	const only = positional[0] === "status" ? positional[1] : null;
	if (only) requireProfile(only, false);
	const list = await describeRuns(only);
	done({ runs: list }, () => {
		if (!list.length) return console.log(only ? `${only} no esta corriendo.` : "No hay proxies corriendo.");
		const rows = [["PERFIL", "TITULO", "USUARIO", "ORG / SPACE", "PUERTO", "PID", "ESTADO", "LOGIN USUARIO"]].concat(
			list.map((r) => [r.profile, r.title || "", r.user || "", `${r.org} / ${r.space}`, String(r.port), String(r.pid), r.status, loginLabel(r.login)])
		);
		const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
		for (const row of rows) console.log(row.map((c, i) => c.padEnd(widths[i])).join("  "));
	});
}

async function cmdLogs() {
	const p = requireProfile(positional[1], false);
	const file = runs.logFile(p.name);
	if (!fs.existsSync(file)) die(EXIT.USAGE, `No hay log de ${p.name} todavia.`);

	process.stdout.write(fs.readFileSync(file, "utf8"));
	if (!flags.follow) process.exit(0);

	// -f: se imprime lo que se agrega. Si el archivo se trunca (nuevo start), se arranca de cero.
	let offset = fs.statSync(file).size;
	fs.watchFile(file, { interval: 500 }, (cur) => {
		if (cur.size < offset) offset = 0;
		if (cur.size === offset) return;
		const fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(cur.size - offset);
		fs.readSync(fd, buf, 0, buf.length, offset);
		fs.closeSync(fd);
		offset = cur.size;
		process.stdout.write(buf.toString("utf8"));
	});
}

// ============================================================================
// cf <p> -- args : el wrapper
// ============================================================================
/** Comandos que no necesitan sesion (o la crean). */
const NO_SESSION_OK = ["login", "logout", "api", "auth", "version", "--version", "help", "-h", "--help", "plugins"];

async function cmdCf() {
	const p = requireProfile(positional[1], false);
	if (!rest.length) die(EXIT.USAGE, "Falta el comando de cf despues de `--`.", { hint: `Ej.: cf-proxy cf ${p.name} -- target` });
	cf.configure({ cfHome: profiles.cfHomeOf(p.name) });

	// Nunca salir del org del perfil: es lo que evita repetir el incidente de BMS.
	const oi = rest.findIndex((a) => a === "-o");
	if (["target", "login"].includes(rest[0]) && oi !== -1 && rest[oi + 1] !== p.org) {
		die(EXIT.USAGE, `El perfil ${p.name} es del org ${p.org}; no se puede apuntar a ${rest[oi + 1]}. Usar el perfil de esa subcuenta.`);
	}

	let where = "(sin chequear sesion)";
	if (!NO_SESSION_OK.includes(rest[0])) {
		const session = await cf.checkLogin();
		if (!session.ok) die(EXIT.NO_SESSION, `El perfil ${p.name} no tiene sesion.`, { hint: `cf-proxy login ${p.name}` });
		if (session.org !== p.org) {
			die(EXIT.USAGE, `La sesion del perfil apunta a ${session.org || "ningun org"}, no a ${p.org}.`, { hint: `cf-proxy login ${p.name}` });
		}
		where = `${session.api} / ${session.org} / ${session.space}`;
	}

	// A stderr, para no ensuciar la salida de `cf` si se la redirige.
	console.error(`[cf-proxy] perfil ${p.name} -> ${where}`);
	process.exit(await cf.passthrough(rest));
}

// ============================================================================
const COMMANDS = {
	profiles: cmdProfiles,
	login: cmdLogin,
	targets: cmdTargets,
	start: cmdStart,
	stop: cmdStop,
	ps: cmdPs,
	status: cmdPs,
	logs: cmdLogs,
	cf: cmdCf
};

const command = COMMANDS[positional[0]];
if (!command) {
	const doc = fs.readFileSync(__filename, "utf8").match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, "");
	console.log(doc.trim());
	process.exit(positional[0] ? EXIT.USAGE : 0);
}
command().catch((e) => die(EXIT.ERROR, e.message));
