/**
 * server.js FALSO para probar la consola (start/stop/ps) sin BTP.
 * Se activa con CF_PROXY_SERVER=test/fake-server.js.
 *
 * Usa el registro y el lock REALES (lib/runs.js) y responde /__health con su
 * identidad, igual que el server de verdad. Tarda un poco en "arrancar" para
 * que los tests vean el estado intermedio y la carrera de dos `start`.
 */
const http = require("http");
const profiles = require("../lib/profiles");
const runs = require("../lib/runs");

const args = process.argv.slice(2);
const name = args[args.indexOf("--profile") + 1];
const p = profiles.get(name);

const logArg = args.indexOf("--log");
const lock = runs.acquire(name, {
	title: p.title, port: p.port, url: `http://localhost:${p.port}/`, org: p.org, space: p.space, user: "fake",
	origin: args[args.indexOf("--origin") + 1], log: logArg === -1 ? null : args[logArg + 1]
});
if (lock.busy) {
	console.log("busy");
	process.exit(runs.EXIT.BUSY);
}
process.on("exit", () => lock.release());
process.on("SIGTERM", () => process.exit(0));

console.log(`fake server ${name} arrancando`);
setTimeout(() => {
	http.createServer((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, profile: name, pid: process.pid, port: p.port, onPremise: false, login: { loggedIn: false } }));
	}).listen(p.port, () => {
		lock.update({ state: "listening" });
		console.log(`Escuchando en http://localhost:${p.port}`);
	});
}, 800);
