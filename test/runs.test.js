/**
 * Test del registro de corridas y del lock (lib/runs.js).
 *
 * En una carpeta temporal (CF_PROXY_HOME). Verifica que un perfil no se
 * pueda tomar dos veces, que el registro de un proceso muerto se reclame, y
 * que el health solo valga si responde el proxy de ESE registro.
 *
 * Uso:  node test/runs.test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

let failed = 0;
function ok(name, cond) {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failed++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfp-runs-"));
process.env.CF_PROXY_HOME = tmp;
const runs = require("../lib/runs");

(async () => {
	// --- Lock --------------------------------------------------------------
	const first = runs.acquire("A", { port: 4701 });
	ok("el primer acquire toma el lock", first.busy === false);
	const second = runs.acquire("A", { port: 4701 });
	ok("el segundo acquire ve el perfil ocupado", second.busy === true && second.record.pid === process.pid);

	first.update({ state: "listening" });
	ok("update escribe en el registro", runs.read("A").state === "listening");
	ok("list muestra la corrida viva", runs.list().some((r) => r.profile === "A"));

	// Otro proceso piso el registro: release no tiene que borrarlo.
	fs.writeFileSync(runs.recordFile("A"), JSON.stringify({ profile: "A", pid: 999999 }));
	first.release();
	ok("release no borra un registro ajeno", fs.existsSync(runs.recordFile("A")));

	// --- Registro de un proceso muerto ---------------------------------------
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	fs.writeFileSync(runs.recordFile("B"), JSON.stringify({ profile: "B", pid: dead, port: 4702 }));
	const reclaimed = runs.acquire("B", { port: 4702 });
	ok("un registro de pid muerto se reclama", reclaimed.busy === false && runs.read("B").pid === process.pid);
	reclaimed.release();
	ok("release propio borra el registro", !fs.existsSync(runs.recordFile("B")));

	fs.writeFileSync(runs.recordFile("C"), JSON.stringify({ profile: "C", pid: dead, port: 4703 }));
	ok("list descarta y borra registros muertos", !runs.list().some((r) => r.profile === "C") && !fs.existsSync(runs.recordFile("C")));

	// --- Health con identidad ------------------------------------------------
	const srv = http.createServer((req, res) => {
		res.end(JSON.stringify({ ok: true, profile: "D", pid: process.pid }));
	});
	await new Promise((r) => srv.listen(4704, r));
	ok("health ok si responde el proxy del registro", Boolean(await runs.health({ profile: "D", pid: process.pid, port: 4704 })));
	ok("health null si en el puerto responde otro perfil", (await runs.health({ profile: "E", pid: process.pid, port: 4704 })) === null);
	ok("health null si no hay nada escuchando", (await runs.health({ profile: "D", pid: process.pid, port: 4799 })) === null);
	const st = await runs.status({ profile: "X", pid: process.pid, port: 4799, state: "starting" });
	ok("status starting mientras arranca", st.status === "starting");
	srv.close();

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed ? `\n${failed} test(s) fallaron` : "\nTodos los tests pasaron");
	process.exit(failed ? 1 : 0);
})();
