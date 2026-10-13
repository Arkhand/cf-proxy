/**
 * PASO 0c - Tuneles a servicios del space (p.ej. PostgreSQL).
 *
 * Por que existe: una base de BTP (PostgreSQL hyperscaler, Redis...) solo es
 * alcanzable desde adentro de CF. Para correr una app local contra ella hace
 * falta un `cf ssh -L` a traves de una app del space. Cada tunel guardado dice
 * de que perfil (subcuenta) es, que instancia de servicio y en que puerto
 * local escucha. El host y el puerto remotos NO se guardan: se leen de los
 * bindings de la instancia al arrancar, asi sobreviven a un cambio de host.
 *
 * Config aparte de los perfiles: ~/.cf-proxy/tunnels.json.
 *
 * Reglas (se calculan al cargar, no se guardan):
 *   - el perfil tiene que existir.
 *   - el puerto no se repite entre tuneles ni con el de un perfil.
 *   - ante un conflicto gana el primero del archivo; el resto queda con `problems`.
 */
const fs = require("fs");
const path = require("path");
const profiles = require("./profiles");

const NAME_RE = /^[A-Za-z0-9._-]+$/;
// Lejos de los puertos por defecto de los servicios (5432, 6379...), por si
// hay uno instalado en la PC.
const FIRST_PORT = 15432;

function tunnelsFile() {
	return path.join(profiles.baseDir(), "tunnels.json");
}

/** Nombre de la corrida en el registro (runs/). `@` no es valido en un perfil: no chocan. */
function runName(name) {
	return `@${name}`;
}

/** Completa defaults: un tunel a medio escribir no rompe la carga. */
function normalize(t) {
	return {
		name: String(t.name || "").trim(),
		profile: String(t.profile || "").trim(),
		service: String(t.service || "").trim(),
		port: Number(t.port),
		// App del space por la que pasa el tunel. Vacio = cf-dest-app o una con SSH.
		app: String(t.app || "").trim()
	};
}

/** Problemas propios del tunel, sin mirar a los demas. */
function ownProblems(t, profileList) {
	const out = [];
	if (!NAME_RE.test(t.name)) out.push("nombre invalido (solo letras, numeros, . _ -)");
	if (!t.profile) out.push("falta el perfil");
	else if (!profileList.some((p) => p.name === t.profile)) out.push(`no existe el perfil ${t.profile}`);
	if (!t.service) out.push("falta la instancia de servicio");
	if (!Number.isInteger(t.port) || t.port < 1024 || t.port > 65535) out.push("puerto invalido (1024-65535)");
	const profilePort = profileList.find((p) => p.port === t.port);
	if (profilePort) out.push(`el puerto ${t.port} lo usa el perfil ${profilePort.name}`);
	return out;
}

/** Problemas de `t` frente a los tuneles que lo preceden (`before`). */
function conflictProblems(t, before) {
	const out = [];
	if (before.some((o) => o.name === t.name)) out.push(`el nombre ${t.name} ya existe`);
	const samePort = before.find((o) => o.port === t.port);
	if (samePort) out.push(`el puerto ${t.port} lo usa el tunel ${samePort.name}`);
	return out;
}

function readRaw() {
	try {
		const data = JSON.parse(fs.readFileSync(tunnelsFile(), "utf8"));
		return (data.tunnels || []).map(normalize);
	} catch (e) {
		return [];
	}
}

/** Escritura atomica: si el proceso muere a mitad, queda el archivo anterior entero. */
function writeRaw(list) {
	fs.mkdirSync(profiles.baseDir(), { recursive: true });
	const tmp = tunnelsFile() + ".tmp";
	const clean = list.map(({ problems, ...t }) => t);
	fs.writeFileSync(tmp, JSON.stringify({ version: 1, tunnels: clean }, null, 2), "utf8");
	fs.renameSync(tmp, tunnelsFile());
}

/** Lista de tuneles, cada uno con `problems` (vacio = puede arrancar). */
function load() {
	const profileList = profiles.load();
	const raw = readRaw();
	return raw.map((t, i) => ({ ...t, problems: [...ownProblems(t, profileList), ...conflictProblems(t, raw.slice(0, i))] }));
}

function get(name) {
	return load().find((t) => t.name === name) || null;
}

/** Primer puerto libre desde 15432 que ningun tunel (salvo `except`) ni perfil usa. */
function nextFreePort(list, except = null) {
	const used = new Set([
		...list.filter((t) => t.name !== except).map((t) => t.port),
		...profiles.load().map((p) => p.port)
	]);
	let port = FIRST_PORT;
	while (used.has(port)) port++;
	return port;
}

/** Al guardar se exige que no tenga problemas, aunque al cargar se toleren. */
function validateAgainst(t, others) {
	const problems = [...ownProblems(t, profiles.load()), ...conflictProblems(t, others)];
	if (problems.length) {
		throw new Error(`Tunel ${t.name || "?"}: ${problems.join("; ")}`);
	}
}

function resolvePort(value, list, name) {
	return value === "auto" || value === undefined ? nextFreePort(list, name) : Number(value);
}

function add(input) {
	const list = readRaw();
	const t = normalize({ ...input, port: resolvePort(input.port, list, input.name) });
	validateAgainst(t, list);
	writeRaw([...list, t]);
	return t;
}

/** Edita campos de un tunel. El nombre no se cambia: es la clave de su corrida. */
function edit(name, patch) {
	const list = readRaw();
	const current = list.find((t) => t.name === name);
	if (!current) {
		throw new Error(`No existe el tunel ${name}.`);
	}
	const merged = { ...current, ...patch, name };
	if (patch.port !== undefined) merged.port = resolvePort(patch.port, list, name);
	const t = normalize(merged);
	validateAgainst(t, list.filter((o) => o.name !== name));
	writeRaw(list.map((o) => (o.name === name ? t : o)));
	return t;
}

function remove(name) {
	const list = readRaw();
	if (!list.some((t) => t.name === name)) {
		throw new Error(`No existe el tunel ${name}.`);
	}
	writeRaw(list.filter((t) => t.name !== name));
}

module.exports = { tunnelsFile, runName, load, get, add, edit, remove, nextFreePort };
