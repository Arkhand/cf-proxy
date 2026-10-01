/**
 * Test del aislamiento de CF_HOME: ningun `cf` usa la sesion global.
 *
 * Usa el `cf` falso (test/fake-cf.js), que anota con que CF_HOME lo llamaron,
 * y una carpeta temporal como CF_PROXY_HOME. Verifica lib/cf.js, el arranque
 * de server.js (sin perfil, sin sesion) y los comandos login/targets/cf de la
 * consola.
 *
 * Uso:  node test/cf-home.test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let failed = 0;
function ok(name, cond) {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failed++;
}

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfp-home-"));
const fakeLog = path.join(tmp, "fake-cf.log");
process.env.CF_PROXY_HOME = path.join(tmp, "home");
process.env.CF_PROXY_LAUNCHER_DIR = path.join(tmp, "sin-launcher");
process.env.CF_PROXY_CF_BIN = path.join(__dirname, "fake-cf.js");
process.env.FAKE_CF_LOG = fakeLog;

const calls = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
const node = (script, args, input) => spawnSync(process.execPath, [script, ...args], { cwd: root, env: process.env, input, encoding: "utf8" });
const cli = (args, input) => node(path.join(root, "bin", "cf-proxy.js"), args, input);
const json = (r) => { try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch (e) { return {}; } };

const profiles = require("../lib/profiles");
profiles.add({ name: "acme", title: "ACME", api: "https://api.cf.eu10.hana.ondemand.com", user: "dev@acme", auth: "password", org: "acme-org", space: "dev", port: 4711 });

(async () => {
	// --- lib/cf.js: sin configure no corre nada --------------------------------
	const cf = require("../lib/cf");
	const unconfigured = await cf.checkLogin();
	ok("sin configure, cf no se ejecuta", !unconfigured.ok && calls().length === 0);

	const acmeHome = profiles.cfHomeOf("acme");
	cf.configure({ cfHome: acmeHome });
	await cf.checkLogin();
	const all = calls();
	ok("con configure, cada cf lleva el CF_HOME del perfil", all.length > 0 && all.every((c) => c.CF_HOME === acmeHome));
	ok("y CF_PLUGIN_HOME apunta al home (plugins globales)", all.every((c) => c.CF_PLUGIN_HOME === (process.env.CF_PLUGIN_HOME || os.homedir())));

	// --- server.js -----------------------------------------------------------
	const noProfile = node(path.join(root, "server.js"), []);
	ok("server.js sin --profile sale con 2", noProfile.status === 2 && /Falta --profile/.test(noProfile.stderr));

	const noSession = node(path.join(root, "server.js"), ["--profile", "acme", "--no-open"]);
	ok("server.js sin sesion en el perfil sale con 4", noSession.status === 4 && /login acme/.test(noSession.stderr));
	ok("y no deja el lock tomado", !fs.existsSync(path.join(process.env.CF_PROXY_HOME, "runs", "acme.json")));

	// --- login por la consola --------------------------------------------------
	const bad = cli(["login", "acme", "--password-stdin", "--json"], "mala\n");
	ok("login con contrasena mala falla con 4", bad.status === 4 && json(bad).ok === false);

	const good = cli(["login", "acme", "--password-stdin", "--json"], "good\n");
	ok("login con contrasena buena", good.status === 0 && json(good).org === "acme-org");
	const authCall = calls().find((c) => c.args[0] === "auth");
	ok("la contrasena no va en la linea de comandos", authCall && !authCall.args.includes("good"));

	const targets = cli(["targets", "acme", "--json"]);
	ok("targets lista los spaces de la sesion del perfil", json(targets).targets && json(targets).targets[0].spaces.includes("dev"));

	// --- login con un org que el usuario no tiene: la sesion queda, con aviso ---
	profiles.add({ name: "wrongorg", api: "https://api.cf.us30.hana.ondemand.com", user: "x@y", auth: "password", org: "org-inexistente", space: "s", port: 4712 });
	const wrong = cli(["login", "wrongorg", "--password-stdin", "--json"], "good\n");
	ok("login con org inexistente igual deja sesion (para listar orgs)", wrong.status === 0 && json(wrong).ok === true);
	ok("y avisa que el org del perfil no existe", /org-inexistente/.test(json(wrong).warning || ""));
	ok("targets anda despues de ese login", cli(["targets", "wrongorg", "--json"]).status === 0);

	// --- wrapper cf ------------------------------------------------------------
	const other = cli(["cf", "acme", "--", "target", "-o", "otro-cliente"]);
	ok("el wrapper rechaza apuntar a otro org", other.status === 2 && /no se puede apuntar a otro-cliente/.test(other.stderr));

	const passthrough = cli(["cf", "acme", "--", "services"]);
	ok("el wrapper corre cf con banner del perfil", passthrough.status === 0 && /\[cf-proxy\] perfil acme -> .*acme-org \/ dev/.test(passthrough.stderr));
	ok("y la salida de cf llega intacta", /fake cf: services/.test(passthrough.stdout));

	ok("ningun cf corrio sin CF_HOME de perfil", calls().every((c) => c.CF_HOME && c.CF_HOME.startsWith(process.env.CF_PROXY_HOME)));

	// --- perfil con problemas no arranca ---------------------------------------
	fs.writeFileSync(path.join(process.env.CF_PROXY_HOME, "profiles.json"), JSON.stringify({
		version: 1,
		profiles: [
			JSON.parse(fs.readFileSync(path.join(process.env.CF_PROXY_HOME, "profiles.json"), "utf8")).profiles[0],
			{ name: "dup", api: "https://x", org: "o2", space: "s", auth: "sso", port: 4711 }
		]
	}));
	const conflicting = node(path.join(root, "server.js"), ["--profile", "dup"]);
	ok("perfil con puerto repetido no arranca (2)", conflicting.status === 2 && /puerto 4711/.test(conflicting.stderr));

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed ? `\n${failed} test(s) fallaron` : "\nTodos los tests pasaron");
	process.exit(failed ? 1 : 0);
})();
