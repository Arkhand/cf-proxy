/**
 * PASO 0a - Perfiles: la unica forma de arrancar cf-proxy.
 *
 * Por que existe: el target de `cf` era global (~/.cf). Un `cf target` hecho
 * para un cliente quedaba vigente para el siguiente comando, y asi un deploy
 * termino en el subaccount equivocado (ver README, incidente de BMS). Ahora
 * cada corrida sale de un perfil guardado = UNA subcuenta de cliente, con su
 * propio CF_HOME y su propio puerto.
 *
 * Reglas (se calculan al cargar, no se guardan):
 *   - (api, org) no se repite: una subcuenta tiene un solo perfil.
 *   - el puerto no se repite entre perfiles.
 *   - ante un conflicto gana el primero del archivo; el resto queda con
 *     `problems` y no puede arrancar hasta corregirlo.
 *
 * Todo vive en ~/.cf-proxy (o en CF_PROXY_HOME, para los tests):
 *   profiles.json, profiles/<name>/cf-home/, runs/
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const AUTH_TYPES = ["password", "sso"];
const FIRST_PORT = 3100;

const DEFAULT_FLAGS = { tunnel: false, login: false, create_keys: false, open_browser: true };

function baseDir() {
	return process.env.CF_PROXY_HOME || path.join(os.homedir(), ".cf-proxy");
}

function profilesFile() {
	return path.join(baseDir(), "profiles.json");
}

/** CF_HOME aislado del perfil. `cf` crea adentro su propio .cf/config.json. */
function cfHomeOf(name) {
	return path.join(baseDir(), "profiles", name, "cf-home");
}

/** Mismo endpoint escrito distinto (barra final, mayusculas) es la misma subcuenta. */
function normalizeApi(api) {
	return String(api || "").trim().replace(/\/+$/, "").toLowerCase();
}

/** Completa defaults: un perfil viejo o a medio escribir no rompe la carga. */
function normalize(p) {
	return {
		name: String(p.name || "").trim(),
		title: String(p.title || p.name || "").trim(),
		api: String(p.api || "").trim(),
		user: String(p.user || "").trim(),
		auth: p.auth || "sso",
		org: String(p.org || "").trim(),
		space: String(p.space || "").trim(),
		port: Number(p.port),
		flags: { ...DEFAULT_FLAGS, ...(p.flags || {}) }
	};
}

/** Problemas propios del perfil, sin mirar a los demas. */
function ownProblems(p) {
	const out = [];
	if (!NAME_RE.test(p.name)) out.push("nombre invalido (solo letras, numeros, . _ -)");
	if (!p.api) out.push("falta el API endpoint");
	if (!p.org) out.push("falta el org");
	if (!p.space) out.push("falta el space");
	if (!AUTH_TYPES.includes(p.auth)) out.push(`auth debe ser ${AUTH_TYPES.join(" o ")}`);
	if (!Number.isInteger(p.port) || p.port < 1024 || p.port > 65535) out.push("puerto invalido (1024-65535)");
	return out;
}

/** Problemas de `p` frente a los perfiles que lo preceden (`before`). */
function conflictProblems(p, before) {
	const out = [];
	const samePort = before.find((o) => o.port === p.port);
	if (samePort) out.push(`el puerto ${p.port} lo usa ${samePort.name}`);

	if (p.org) {
		const sameSub = before.find((o) => o.org && normalizeApi(o.api) === normalizeApi(p.api) && o.org === p.org);
		if (sameSub) out.push(`la subcuenta ${p.org} ya tiene el perfil ${sameSub.name}`);
	}
	return out;
}

function readRaw() {
	try {
		const data = JSON.parse(fs.readFileSync(profilesFile(), "utf8"));
		return (data.profiles || []).map(normalize);
	} catch (e) {
		return [];
	}
}

/** Escritura atomica: si el proceso muere a mitad, queda el archivo anterior entero. */
function writeRaw(profiles) {
	fs.mkdirSync(baseDir(), { recursive: true });
	const tmp = profilesFile() + ".tmp";
	const clean = profiles.map(({ problems, ...p }) => p);
	fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: clean }, null, 2), "utf8");
	fs.renameSync(tmp, profilesFile());
}

/** Lista de perfiles, cada uno con `problems` (vacio = puede arrancar). */
function load() {
	importLauncher();
	const raw = readRaw();
	return raw.map((p, i) => ({ ...p, problems: [...ownProblems(p), ...conflictProblems(p, raw.slice(0, i))] }));
}

function get(name) {
	return load().find((p) => p.name === name) || null;
}

/** Primer puerto libre desde 3100 que ningun perfil (salvo `except`) usa. */
function nextFreePort(profiles, except = null) {
	const used = new Set(profiles.filter((p) => p.name !== except).map((p) => p.port));
	let port = FIRST_PORT;
	while (used.has(port)) port++;
	return port;
}

/**
 * Valida un perfil nuevo o editado contra todos los demas. Al guardar se
 * exige que no tenga problemas, aunque al cargar se toleren (perfiles viejos).
 *
 * Excepcion: se puede guardar sin org/space (borrador). Hace falta para el
 * alta desde la ventana: primero se loguea con el CF_HOME del perfil, y
 * recien con la sesion se pueden listar los orgs para elegir. Un borrador no
 * arranca: su falta de org/space queda en `problems`.
 */
function validateAgainst(p, others) {
	const draftOk = (msg) => msg !== "falta el org" && msg !== "falta el space";
	const problems = [...ownProblems(p).filter(draftOk), ...conflictProblems(p, others)];
	if (problems.length) {
		throw new Error(`Perfil ${p.name || "?"}: ${problems.join("; ")}`);
	}
}

function resolvePort(value, profiles, name) {
	return value === "auto" ? nextFreePort(profiles, name) : Number(value);
}

function add(input) {
	const profiles = readRaw();
	if (profiles.some((p) => p.name === input.name)) {
		throw new Error(`Ya existe el perfil ${input.name}.`);
	}
	const p = normalize({ ...input, port: resolvePort(input.port ?? "auto", profiles, input.name) });
	validateAgainst(p, profiles);
	writeRaw([...profiles, p]);
	return p;
}

/** Edita campos de un perfil. El nombre no se cambia: es la clave del CF_HOME y del secreto. */
function edit(name, patch) {
	const profiles = readRaw();
	const current = profiles.find((p) => p.name === name);
	if (!current) {
		throw new Error(`No existe el perfil ${name}.`);
	}
	const merged = {
		...current,
		...patch,
		name,
		flags: { ...current.flags, ...(patch.flags || {}) }
	};
	if (patch.port !== undefined) merged.port = resolvePort(patch.port, profiles, name);
	const p = normalize(merged);
	validateAgainst(p, profiles.filter((o) => o.name !== name));
	writeRaw(profiles.map((o) => (o.name === name ? p : o)));
	return p;
}

/** Saca el perfil y su CF_HOME (la sesion de cf de esa subcuenta). */
function remove(name) {
	const profiles = readRaw();
	if (!profiles.some((p) => p.name === name)) {
		throw new Error(`No existe el perfil ${name}.`);
	}
	writeRaw(profiles.filter((p) => p.name !== name));
	fs.rmSync(path.join(baseDir(), "profiles", name), { recursive: true, force: true });
}

/**
 * Migracion unica desde el launcher viejo (%APPDATA%\cf-proxy-launcher).
 *
 * Solo corre si todavia no hay profiles.json. Se importa todo tal cual; los
 * que choquen (por ejemplo, todos en el puerto 3100) quedan con `problems`
 * hasta que se corrijan. El archivo viejo no se toca.
 */
function importLauncher() {
	if (fs.existsSync(profilesFile())) {
		return false;
	}
	const appData = process.env.CF_PROXY_LAUNCHER_DIR ||
		path.join(process.env.APPDATA || os.homedir(), "cf-proxy-launcher");
	let old;
	try {
		old = JSON.parse(fs.readFileSync(path.join(appData, "profiles.json"), "utf8")).profiles || [];
	} catch (e) {
		return false;
	}

	const imported = old.map((o) => normalize({
		name: o.name,
		title: o.name,
		api: o.api,
		user: o.user,
		auth: o.auth,
		org: o.org,
		space: o.space,
		port: o.port,
		flags: { tunnel: o.tunnel, login: o.login, create_keys: o.create_keys, open_browser: o.open_browser }
	}));
	writeRaw(imported);
	return true;
}

/**
 * El login de usuario (PrincipalPropagation, UserTokenExchange) vuelve a
 * http://localhost:<puerto>/__callback. XSUAA solo acepta los puertos que
 * figuran en las redirect-uris de xs-security.json. Devuelve null si el
 * puerto esta cubierto, o el aviso a mostrar.
 */
function checkXsuaaPort(port, xsSecurityPath = path.join(__dirname, "..", "xs-security.json")) {
	let uris;
	try {
		uris = JSON.parse(fs.readFileSync(xsSecurityPath, "utf8"))["oauth2-configuration"]["redirect-uris"] || [];
	} catch (e) {
		return null;
	}
	const target = `http://localhost:${port}/__callback`;
	const matches = uris.some((u) => {
		const re = "^" + u.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$";
		return new RegExp(re).test(target);
	});
	return matches
		? null
		: `El puerto ${port} no esta en las redirect-uris de xs-security.json: el login de usuario va a fallar con invalid_redirect.`;
}

module.exports = {
	baseDir,
	cfHomeOf,
	load,
	get,
	add,
	edit,
	remove,
	nextFreePort,
	importLauncher,
	checkXsuaaPort,
	normalizeApi
};
