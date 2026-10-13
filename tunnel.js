#!/usr/bin/env node
/**
 * cf-proxy - tunel local a un servicio del space (p.ej. PostgreSQL).
 *
 * Deja `localhost:<puerto>` apuntando al host interno de una instancia de
 * servicio, con `cf ssh -L` a traves de una app del space. Sirve para correr
 * una app local (CAP en modo hybrid, un cliente SQL) contra la base de BTP.
 *
 * No hay nada hardcodeado: el host y el puerto remotos se leen de los
 * bindings que ya tiene la instancia (de una app o una key), y la app de salto
 * es la indicada en el tunel, cf-dest-app, o cualquiera con SSH.
 *
 * Lo normal es arrancarlo con la consola (bin/cf-proxy.js tunnels start <t>),
 * que lo deja en segundo plano y lo registra en runs/ como `@<tunel>`.
 *
 * Los pasos, en orden:
 *   [0] Cargar el tunel y su perfil, tomar el lock y verificar el puerto local.
 *   [1] Sesion de CF del perfil y target a su org/space.
 *   [2] Leer host y puerto de la instancia (de un binding existente).
 *   [3] Elegir la app de salto.
 *   [4] Abrir el tunel y quedarse corriendo hasta que lo corten.
 *
 * Uso:
 *   node tunnel.js --tunnel <t> [--origin cli] [--log <archivo>]
 */
const net = require("net");
const cf = require("./lib/cf");
const profiles = require("./lib/profiles");
const runs = require("./lib/runs");
const sessions = require("./lib/sessions");
const tunnels = require("./lib/tunnels");
const sshTunnel = require("./lib/sshtunnel");

const args = process.argv.slice(2);
const value = (flag, fallback) => {
	const i = args.indexOf(flag);
	return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const log = (m) => console.log(m);
const CLI_HINT = "node bin/cf-proxy.js";

/** Corta la ejecucion con un mensaje de error legible. `code`: ver runs.EXIT. */
function fail(title, hint, code = runs.EXIT.ERROR) {
	console.error(`\n  ERROR: ${title}`);
	if (hint) console.error(`  ${hint}`);
	console.error("");
	process.exit(code);
}

/** Una credencial sirve si trae a donde conectarse. */
const hasHostAndPort = (c) => Boolean(c && (c.hostname || c.host) && c.port);

/** true si el puerto local esta libre. Se prueba igual que lo va a abrir `cf ssh`. */
function portFree(port) {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.once("error", () => resolve(false));
		srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
	});
}

// ============================================================================
// PASO 0a - El tunel y su perfil
// ============================================================================
const TUNNEL_NAME = value("--tunnel", null);
if (!TUNNEL_NAME) {
	fail("Falta --tunnel.", `Ver: ${CLI_HINT} tunnels list`, runs.EXIT.USAGE);
}
const TUNNEL = tunnels.get(TUNNEL_NAME);
if (!TUNNEL) {
	fail(`No existe el tunel ${TUNNEL_NAME}.`, `Ver: ${CLI_HINT} tunnels list`, runs.EXIT.USAGE);
}
if (TUNNEL.problems.length) {
	fail(`El tunel ${TUNNEL_NAME} no puede arrancar: ${TUNNEL.problems.join("; ")}.`,
		`Corregirlo con: ${CLI_HINT} tunnels edit ${TUNNEL_NAME} ...`, runs.EXIT.USAGE);
}
const PROFILE = profiles.get(TUNNEL.profile);
if (PROFILE.problems.length) {
	fail(`El perfil ${PROFILE.name} del tunel no puede usarse: ${PROFILE.problems.join("; ")}.`, null, runs.EXIT.USAGE);
}

// Todo `cf` corre en una copia privada de la sesion del perfil, igual que el proxy.
const sessionRun = sessions.openRun(profiles.sessionHomeOf(PROFILE));
cf.configure({ cfHome: sessionRun.home });

let run = null;
let child = null;

function closeTunnel() {
	if (child && child.exitCode === null && !child.killed) child.kill();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => process.exit(0));
}
process.on("exit", () => {
	closeTunnel();
	if (run) run.release();
	try {
		sessions.writeBack(sessionRun);
	} finally {
		sessions.closeRun(sessionRun);
	}
});

async function main() {
	const PORT = TUNNEL.port;
	log(`\n  cf-proxy - tunel ${TUNNEL.name}: localhost:${PORT} -> ${TUNNEL.service}`);
	log(`  Perfil: ${PROFILE.title} (${PROFILE.name})  ->  ${PROFILE.org} / ${PROFILE.space}\n`);

	// ========================================================================
	// PASO 0b - Lock de la corrida y puerto libre
	// ========================================================================
	const lock = runs.acquire(tunnels.runName(TUNNEL.name), {
		kind: "tunnel",
		tunnel: TUNNEL.name,
		forProfile: PROFILE.name,
		title: PROFILE.title,
		service: TUNNEL.service,
		port: PORT,
		url: `localhost:${PORT}`,
		api: PROFILE.api,
		org: PROFILE.org,
		space: PROFILE.space,
		user: PROFILE.user,
		origin: value("--origin", "foreground"),
		log: value("--log", null)
	});
	if (lock.busy) {
		const r = lock.record;
		fail(`El tunel ${TUNNEL.name} ya esta corriendo${r ? ` (pid ${r.pid}) en ${r.url}` : ""}.`,
			`Ver: ${CLI_HINT} ps   Detener: ${CLI_HINT} tunnels stop ${TUNNEL.name}`, runs.EXIT.BUSY);
	}
	run = lock;

	if (!(await portFree(PORT))) {
		fail(`El puerto ${PORT} esta ocupado por otro programa.`,
			`Liberarlo, o cambiar el puerto: ${CLI_HINT} tunnels edit ${TUNNEL.name} --port auto`, runs.EXIT.PORT_BUSY);
	}

	// ========================================================================
	// PASO 1 - Sesion de CF (la del perfil) y target fijo
	// ========================================================================
	log("[1/4] Verificando sesion de Cloud Foundry del perfil...");
	const session = await cf.checkLogin();
	if (!session.ok) {
		fail(`El perfil ${PROFILE.name} no tiene sesion de CF (o vencio).`,
			`Loguearse con: ${CLI_HINT} login ${PROFILE.name}`, runs.EXIT.NO_SESSION);
	}
	if (PROFILE.user && String(session.user).toLowerCase() !== PROFILE.user.toLowerCase()) {
		fail(`La sesion es de ${session.user}, pero el perfil es de ${PROFILE.user}.`,
			`Volver a loguearse con: ${CLI_HINT} login ${PROFILE.name}`, runs.EXIT.MISMATCH);
	}
	const targeted = await cf.setTarget(PROFILE.org, PROFILE.space);
	if (!targeted.ok) {
		fail(`No se pudo apuntar a ${PROFILE.org} / ${PROFILE.space}: ${targeted.error}`);
	}
	run.update({ user: session.user });
	log(`  OK  ${session.user} -> ${PROFILE.org} / ${PROFILE.space}`);

	// ========================================================================
	// PASO 2 - Host y puerto de la instancia
	// ========================================================================
	// Se leen en cada arranque (no se guardan): si la instancia cambia de host,
	// el tunel sigue andando sin tocar la config.
	log(`\n[2/4] Leyendo host y puerto de ${TUNNEL.service}...`);
	const found = await cf.readInstanceCredentials(TUNNEL.service, hasHostAndPort);
	if (!found.ok) {
		fail(found.error, `Crear una key para leerlo: ${CLI_HINT} cf ${PROFILE.name} -- create-service-key ${TUNNEL.service} <nombre>`);
	}
	const remoteHost = found.creds.hostname || found.creds.host;
	const remotePort = Number(found.creds.port);
	log(`  OK  ${remoteHost}:${remotePort} (del binding ${found.binding.type}${found.binding.name ? ` ${found.binding.name}` : ""})`);

	// ========================================================================
	// PASO 3 - App de salto
	// ========================================================================
	log("\n[3/4] Eligiendo la app para el tunel...");
	const appName = await sshTunnel.pickApp(TUNNEL.app || null, log);
	if (!appName) {
		fail("No hay app para el tunel.", sshTunnel.NO_APP_HINT);
	}
	log(`  OK  ${appName}`);

	// ========================================================================
	// PASO 4 - Abrir el tunel y quedarse corriendo
	// ========================================================================
	log(`\n[4/4] Abriendo tunel via ${appName}: localhost:${PORT} -> ${remoteHost}:${remotePort}`);
	const opened = await sshTunnel.open({
		appName, localPort: PORT, remoteHost, remotePort,
		onSpawn: (c) => {
			child = c;
			run.update({ tunnelPid: c.pid });
		}
	});
	if (!opened.ok) {
		fail("No se pudo abrir el tunel SSH.", opened.reason);
	}

	// Recien ahora la corrida esta lista: `tunnels start` de la consola espera esto.
	run.update({ state: "listening", app: appName, remote: `${remoteHost}:${remotePort}` });
	log(`\n  Escuchando en localhost:${PORT}  (${TUNNEL.service} via ${appName})`);
	log("  Las credenciales (usuario, contrasena, certificados) son las del binding: el tunel solo cambia host y puerto.\n");

	// Si `cf ssh` se corta (red, app reiniciada), la corrida termina: se ve en `ps` y se vuelve a arrancar.
	child.on("exit", (code) => {
		log(`\n  El tunel se corto (cf ssh salio con ${code}).`);
		process.exit(runs.EXIT.ERROR);
	});
}

main().catch((e) => fail(e.message));
