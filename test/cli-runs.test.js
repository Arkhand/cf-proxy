/**
 * Test de la consola: start / ps / logs / stop, con un server falso.
 *
 * CF_PROXY_SERVER apunta a test/fake-server.js, que usa el registro y el lock
 * reales. Verifica que `start` deje el proxy en segundo plano y devuelva la
 * URL, que sea idempotente, que dos `start` simultaneos terminen en UNA sola
 * corrida, y que `stop` lo corte y limpie.
 *
 * Uso:  node test/cli-runs.test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

let failed = 0;
function ok(name, cond) {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failed++;
}

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfp-cli-"));
process.env.CF_PROXY_HOME = tmp;
process.env.CF_PROXY_LAUNCHER_DIR = path.join(tmp, "sin-launcher");
process.env.CF_PROXY_SERVER = path.join(__dirname, "fake-server.js");

const CLI = path.join(root, "bin", "cf-proxy.js");
const lastJson = (text) => { try { return JSON.parse(text.trim().split("\n").pop()); } catch (e) { return {}; } };
const cli = (args) => {
	const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, env: process.env, encoding: "utf8" });
	return { status: r.status, body: lastJson(r.stdout) };
};
const cliAsync = (args) => new Promise((resolve) => {
	const child = spawn(process.execPath, [CLI, ...args, "--json"], { cwd: root, env: process.env });
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	child.on("exit", (status) => resolve({ status, body: lastJson(out) }));
});

const profiles = require("../lib/profiles");
const runs = require("../lib/runs");
profiles.add({ name: "uno", title: "Cliente Uno", api: "https://a", org: "o1", space: "s", port: 4721 });
profiles.add({ name: "dos", title: "Cliente Dos", api: "https://a", org: "o2", space: "s", port: 4722 });

(async () => {
	// --- start ---------------------------------------------------------------
	const started = cli(["start", "uno"]);
	ok("start devuelve la URL", started.status === 0 && started.body.url === "http://localhost:4721/" && started.body.already === false);

	const again = cli(["start", "uno"]);
	ok("start otra vez devuelve la misma corrida", again.status === 0 && again.body.already === true && again.body.pid === started.body.pid);

	// --- ps --------------------------------------------------------------------
	const ps = cli(["ps"]);
	const row = (ps.body.runs || []).find((r) => r.profile === "uno");
	ok("ps lista la corrida con titulo, org/space, puerto y health", row && row.title === "Cliente Uno" && row.org === "o1" && row.port === 4721 && row.status === "ok");

	// --- logs ------------------------------------------------------------------
	const logs = spawnSync(process.execPath, [CLI, "logs", "uno"], { cwd: root, env: process.env, encoding: "utf8" });
	ok("logs muestra la salida de la corrida", /Escuchando en http:\/\/localhost:4721/.test(logs.stdout));

	// --- dos start a la vez: una sola corrida ------------------------------------
	const [a, b] = await Promise.all([cliAsync(["start", "dos"]), cliAsync(["start", "dos"])]);
	ok("dos start simultaneos terminan bien", a.status === 0 && b.status === 0);
	ok("y apuntan al MISMO proceso", a.body.pid && a.body.pid === b.body.pid);
	ok("uno de los dos dice already", [a.body.already, b.body.already].includes(true));

	// --- stop ------------------------------------------------------------------
	const stopped = cli(["stop", "uno"]);
	ok("stop corta la corrida", stopped.status === 0 && stopped.body.wasRunning === true && !runs.pidAlive(started.body.pid));
	ok("y borra el registro", !fs.existsSync(runs.recordFile("uno")));
	ok("stop de algo detenido es idempotente", cli(["stop", "uno"]).body.wasRunning === false);
	ok("stop de uno no corta al otro", cli(["status", "dos"]).body.runs.length === 1);

	// --- remove no borra un perfil corriendo -------------------------------------
	ok("remove se niega si el perfil corre", cli(["profiles", "remove", "dos"]).status === runs.EXIT.BUSY);

	cli(["stop", "dos"]);
	ok("ps vacio al final", cli(["ps"]).body.runs.length === 0);

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed ? `\n${failed} test(s) fallaron` : "\nTodos los tests pasaron");
	process.exit(failed ? 1 : 0);
})();
