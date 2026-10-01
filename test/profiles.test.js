/**
 * Test de los perfiles (lib/profiles.js).
 *
 * Corre en una carpeta temporal (CF_PROXY_HOME): no toca ~/.cf-proxy ni el
 * launcher real. Verifica las reglas que evitan dos proxies a la misma
 * subcuenta o al mismo puerto, y la migracion desde el launcher viejo.
 *
 * Uso:  node test/profiles.test.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

let failed = 0;
function ok(name, cond) {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
	if (!cond) failed++;
}
function throws(name, fn, re) {
	try {
		fn();
		ok(name, false);
	} catch (e) {
		ok(name, re ? re.test(e.message) : true);
	}
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfp-profiles-"));
process.env.CF_PROXY_HOME = path.join(tmp, "home");
process.env.CF_PROXY_LAUNCHER_DIR = path.join(tmp, "launcher");
process.env.CF_TARGET_HOME = path.join(tmp, "sessions");

// Igual que los perfiles reales del launcher: todos en 3100, mismo org en distintas apis.
fs.mkdirSync(process.env.CF_PROXY_LAUNCHER_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.CF_PROXY_LAUNCHER_DIR, "profiles.json"), JSON.stringify({
	profiles: [
		{ name: "Trial", api: "https://api.cf.us10-001.hana.ondemand.com", org: "ORG-A", space: "S", port: 3100, auth: "password", tunnel: true },
		{ name: "Client", api: "https://api.cf.us10-001.hana.ondemand.com", org: "ORG-B", space: "S", port: 3100, auth: "password" },
		{ name: "Other", api: "https://api.cf.us10.hana.ondemand.com", org: "ORG-A", space: "S", port: 3100, auth: "password" }
	]
}));

const profiles = require("../lib/profiles");

// --- Migracion -------------------------------------------------------------
const loaded = profiles.load();
ok("importa los 3 perfiles del launcher", loaded.length === 3);
ok("el primero queda valido", loaded[0].problems.length === 0);
ok("los flags planos pasan a flags{}", loaded[0].flags.tunnel === true && loaded[0].flags.open_browser === true);
ok("el segundo choca por puerto", loaded[1].problems.some((p) => /puerto 3100/.test(p)));
ok("mismo org en otra api NO es la misma subcuenta", !loaded[2].problems.some((p) => /subcuenta/.test(p)));
ok("no reimporta si ya hay profiles.json", profiles.importLauncher() === false);

// --- Edicion: arreglar el puerto deja el perfil valido ----------------------
const fixed = profiles.edit("Client", { port: "auto" });
ok("port auto asigna el siguiente libre", fixed.port === 3101);
ok("Client queda valido", profiles.get("Client").problems.length === 0);
throws("no se puede editar a un puerto usado", () => profiles.edit("Client", { port: 3100 }), /puerto 3100/);
ok("edit fallido no escribe", profiles.get("Client").port === 3101);

// --- Alta ------------------------------------------------------------------
throws("rechaza la misma subcuenta", () => profiles.add({
	name: "Dup", api: "https://API.cf.us10-001.hana.ondemand.com/", org: "ORG-A", space: "X", auth: "sso"
}), /subcuenta ORG-A/);
throws("rechaza nombre invalido", () => profiles.add({ name: "a b", api: "x", org: "o", space: "s" }), /nombre invalido/);
throws("rechaza auth desconocido", () => profiles.add({ name: "z", api: "x", org: "o", space: "s", auth: "magic" }), /auth/);
throws("rechaza nombre repetido", () => profiles.add({ name: "Trial", api: "x", org: "o", space: "s" }), /Ya existe/);

const added = profiles.add({ name: "New", title: "Cliente nuevo", api: "https://api.cf.eu10.hana.ondemand.com", org: "ORG-C", space: "dev" });
ok("alta sin puerto toma uno libre", added.port === 3102);
ok("title se guarda", profiles.get("New").title === "Cliente nuevo");

// --- Borrador: sin org/space se guarda, pero no puede arrancar -------------
profiles.add({ name: "Draft", api: "https://api.cf.ap10.hana.ondemand.com", user: "u", auth: "password" });
ok("un borrador sin org/space se guarda", profiles.get("Draft") !== null);
ok("pero queda con problems (no arranca)", profiles.get("Draft").problems.some((p) => /falta el org/.test(p)));
profiles.remove("Draft");

// --- Baja ------------------------------------------------------------------
const newHome = profiles.sessionHomeOf(profiles.get("New"));
fs.mkdirSync(newHome, { recursive: true });
profiles.remove("New");
ok("remove saca el perfil", profiles.get("New") === null);
ok("remove NO borra la sesion (la comparten cf-target y otros perfiles)", fs.existsSync(newHome));

// Migracion: la sesion vieja del perfil pasa al store compartido.
const oldCfg = path.join(process.env.CF_PROXY_HOME, "profiles", "Client", "cf-home", ".cf", "config.json");
fs.mkdirSync(path.dirname(oldCfg), { recursive: true });
fs.writeFileSync(oldCfg, JSON.stringify({ AccessToken: "old" }));
ok("migrateSessions copia la sesion vieja", profiles.migrateSessions() === 1 &&
	JSON.parse(fs.readFileSync(path.join(profiles.sessionHomeOf(profiles.get("Client")), ".cf", "config.json"), "utf8")).AccessToken === "old");
ok("migrateSessions es idempotente", profiles.migrateSessions() === 0);

// --- Escritura atomica: no quedan temporales --------------------------------
ok("no queda profiles.json.tmp", !fs.existsSync(path.join(process.env.CF_PROXY_HOME, "profiles.json.tmp")));

// --- XSUAA redirect-uris -----------------------------------------------------
const xs = path.join(tmp, "xs.json");
fs.writeFileSync(xs, JSON.stringify({ "oauth2-configuration": { "redirect-uris": ["http://localhost:3100/**"] } }));
ok("3100 cubierto por la redirect-uri", profiles.checkXsuaaPort(3100, xs) === null);
ok("3101 no cubierto: avisa", /3101/.test(profiles.checkXsuaaPort(3101, xs) || ""));
fs.writeFileSync(xs, JSON.stringify({ "oauth2-configuration": { "redirect-uris": ["http://localhost:*/**"] } }));
ok("comodin de puerto cubre 3107", profiles.checkXsuaaPort(3107, xs) === null);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} test(s) fallaron` : "\nTodos los tests pasaron");
process.exit(failed ? 1 : 0);
