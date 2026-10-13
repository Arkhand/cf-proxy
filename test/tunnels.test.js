/**
 * Test de los tuneles a servicios (lib/tunnels.js, tunnel.js y `cf-proxy tunnels`).
 *
 * Config: validacion de perfil, puertos (contra tuneles y perfiles) y puerto auto.
 * Corrida: con el `cf` falso, `tunnels start` lee host/puerto del binding, abre el
 * port-forward y los bytes llegan a un servidor "remoto" local; `ps` lo muestra,
 * `start` es idempotente y `stop` lo corta y libera el puerto.
 *
 * Uso:  node test/tunnels.test.js
 */
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let failed = 0;
function ok(name, cond) {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failed++;
}

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfp-tun-"));
process.env.CF_PROXY_HOME = path.join(tmp, "home");
process.env.CF_PROXY_LAUNCHER_DIR = path.join(tmp, "sin-launcher");
process.env.CF_PROXY_CF_BIN = path.join(__dirname, "fake-cf.js");
process.env.CF_TARGET_HOME = path.join(tmp, "sessions");

const CLI = path.join(root, "bin", "cf-proxy.js");
const lastJson = (text) => { try { return JSON.parse(text.trim().split("\n").pop()); } catch (e) { return {}; } };
const cli = (args) => {
	const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, env: process.env, encoding: "utf8" });
	return { status: r.status, body: lastJson(r.stdout) };
};

/** Manda `text` a localhost:port y devuelve lo que vuelve (o null). */
const roundTrip = (port, text) => new Promise((resolve) => {
	const s = net.connect(port, "127.0.0.1", () => s.write(text));
	s.setTimeout(3000, () => { s.destroy(); resolve(null); });
	s.on("data", (d) => { s.destroy(); resolve(String(d)); });
	s.on("error", () => resolve(null));
	s.on("close", () => resolve(null)); // cerrado sin respuesta (resolve solo vale la primera vez)
});

/** Un puerto que el sistema da libre: el test no puede depender de que 15432 lo este. */
const freePort = () => new Promise((resolve) => {
	const srv = net.createServer().listen(0, "127.0.0.1", () => {
		const { port } = srv.address();
		srv.close(() => resolve(port));
	});
});

const profiles = require("../lib/profiles");
const tunnels = require("../lib/tunnels");
const runs = require("../lib/runs");
const sessions = require("../lib/sessions");

const acme = profiles.add({ name: "acme", title: "ACME", api: "https://api.cf.eu10.hana.ondemand.com", user: "dev@acme", auth: "password", org: "acme-org", space: "dev", port: 4731 });

// Sesion falsa ya logueada (la guarda el cf falso en config.json).
const cfg = sessions.configFile(profiles.sessionHomeOf(acme));
fs.mkdirSync(path.dirname(cfg), { recursive: true });
fs.writeFileSync(cfg, JSON.stringify({ logged: true, api: acme.api, user: acme.user }));

(async () => {
	// --- config ----------------------------------------------------------------
	const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
	ok("un tunel necesita un perfil existente", throws(() => tunnels.add({ name: "x", profile: "nadie", service: "pg", port: 15500 })));
	ok("no puede usar el puerto de un perfil", throws(() => tunnels.add({ name: "x", profile: "acme", service: "pg", port: 4731 })));

	const first = tunnels.add({ name: "pg-a", profile: "acme", service: "pg" });
	ok("sin puerto toma el primero libre desde 15432", first.port === 15432);
	const second = tunnels.add({ name: "pg-b", profile: "acme", service: "pg", port: "auto" });
	ok("y el siguiente no repite", second.port === 15433);
	ok("no repite puerto con otro tunel", throws(() => tunnels.add({ name: "pg-c", profile: "acme", service: "pg", port: 15432 })));
	ok("no repite nombre", throws(() => tunnels.add({ name: "pg-a", profile: "acme", service: "pg", port: 15499 })));
	tunnels.remove("pg-b");

	// --- corrida ---------------------------------------------------------------
	// El "PostgreSQL remoto": un eco con prefijo, en un puerto libre.
	const remote = net.createServer((c) => c.on("data", (d) => c.write("eco:" + d))).listen(0, "127.0.0.1");
	await new Promise((r) => remote.once("listening", r));
	process.env.FAKE_PG_PORT = String(remote.address().port);
	const PORT = await freePort();
	tunnels.edit("pg-a", { app: "una-app", port: PORT });

	const started = cli(["tunnels", "start", "pg-a"]);
	ok("start devuelve localhost:puerto", started.status === 0 && started.body.port === PORT && started.body.already === false);
	ok("con el host remoto leido del binding", started.body.remote === `127.0.0.1:${process.env.FAKE_PG_PORT}`);
	ok("y la app de salto", started.body.app === "una-app");
	ok("los bytes pasan por el tunel", (await roundTrip(PORT, "hola")) === "eco:hola");

	const again = cli(["tunnels", "start", "pg-a"]);
	ok("start otra vez devuelve la misma corrida", again.status === 0 && again.body.already === true && again.body.pid === started.body.pid);

	const ps = cli(["ps"]);
	const row = (ps.body.tunnels || []).find((t) => t.tunnel === "pg-a");
	ok("ps lista el tunel con su estado", row && row.status === "ok" && row.profile === "acme" && row.port === PORT);
	ok("y no lo mezcla con los proxies", (ps.body.runs || []).length === 0);

	const stopped = cli(["tunnels", "stop", "pg-a"]);
	ok("stop corta el tunel", stopped.status === 0 && stopped.body.wasRunning === true && !runs.pidAlive(started.body.pid));
	await new Promise((r) => setTimeout(r, 500));
	ok("y libera el puerto (sin cf ssh huerfano)", (await roundTrip(PORT, "x")) === null);
	ok("y borra el registro", !fs.existsSync(runs.recordFile(tunnels.runName("pg-a"))));

	// --- errores ---------------------------------------------------------------
	tunnels.add({ name: "sin-inst", profile: "acme", service: "otra", port: await freePort(), app: "una-app" });
	const missing = cli(["tunnels", "start", "sin-inst"]);
	ok("instancia inexistente: falla con el motivo", missing.status !== 0 && /No existe la instancia otra/.test(fs.readFileSync(runs.logFile("@sin-inst"), "utf8")));

	tunnels.add({ name: "sin-ssh", profile: "acme", service: "pg", port: await freePort(), app: "app-sin-ssh" });
	const noSsh = cli(["tunnels", "start", "sin-ssh"]);
	ok("app sin SSH: falla y no queda el lock", noSsh.status !== 0 && !fs.existsSync(runs.recordFile("@sin-ssh")));

	remote.close();
	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed ? `\n${failed} test(s) fallaron` : "\nTodos los tests pasaron");
	process.exit(failed ? 1 : 0);
})();
