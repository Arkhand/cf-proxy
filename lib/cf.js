/**
 * PASO 1 y 2 - Todo lo que se habla con el `cf` CLI.
 *
 * Este modulo es el unico que ejecuta `cf`. El resto de la solucion recibe
 * datos ya normalizados y no sabe que existe un CLI por debajo.
 *
 * Principio de diseno: NADA hardcodeado. No se asume ningun nombre de
 * instancia, ni de org, ni de space. Todo se descubre preguntandole a CF,
 * para que la misma herramienta sirva en cualquier subaccount.
 *
 * Aislamiento: cada `cf` corre con el CF_HOME del perfil (configure()), nunca
 * con el ~/.cf global. Asi un `cf target` de un proxy no cambia el de la
 * terminal del usuario ni el de otro proxy, y dos clientes pueden correr a la
 * vez. Sin configure() no se ejecuta nada: es la garantia de que ningun
 * camino de codigo vuelve a usar la sesion global por descuido.
 */
const fs = require("fs");
const os = require("os");
const { execFile, spawn } = require("child_process");
const { URL } = require("url");

/** Ejecutable del CLI. En Windows hay que nombrar el .exe: sin shell, execFile no prueba extensiones. */
const CF_BIN = process.env.CF_PROXY_CF_BIN || (process.platform === "win32" ? "cf.exe" : "cf");

/** CF_HOME del perfil activo. null = no configurado: cf() se niega a correr. */
let cfHome = null;

function configure(options) {
	cfHome = options.cfHome;
	fs.mkdirSync(cfHome, { recursive: true });
}

/**
 * Entorno de cada `cf`. CF_PLUGIN_HOME apunta al home del usuario porque `cf`
 * busca los plugins en $CF_HOME/.cf/plugins: sin esto, `cf deploy` dentro de
 * un perfil no encontraria el plugin multiapps. Los plugins se leen del
 * ~/.cf global; la sesion (config.json) queda en el perfil.
 */
function cfEnv(home, extra = {}) {
	return { ...process.env, CF_HOME: home, CF_PLUGIN_HOME: process.env.CF_PLUGIN_HOME || os.homedir(), ...extra };
}

/** Comando real a ejecutar. Un .js (el cf falso de los tests) se corre con node. */
function command(args) {
	return CF_BIN.endsWith(".js") ? [process.execPath, [CF_BIN, ...args]] : [CF_BIN, args];
}

const NOT_CONFIGURED = "cf.js sin CF_HOME: falta cf.configure({ cfHome }) con el perfil.";

/** Ejecuta un comando `cf` y devuelve stdout. No tira: devuelve {ok, out}. */
function cf(args, timeout = 60000, env = {}) {
	if (!cfHome) {
		return Promise.resolve({ ok: false, out: "", err: NOT_CONFIGURED });
	}
	return new Promise((resolve) => {
		const [bin, argv] = command(args);
		// Sin `shell: true` a proposito: los argumentos van literales y el shell
		// no puede romper el `&` de las query strings de `cf curl`.
		const child = execFile(bin, argv, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: cfEnv(cfHome, env) }, (err, stdout, stderr) => {
			resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || (err && err.message) || "") });
		});
		// Sin stdin: si `cf` pregunta algo (p.ej. elegir org al loguear), recibe
		// EOF y sigue, en vez de quedar esperando hasta el timeout.
		child.stdin.end();
	});
}

/**
 * Ejecuta `cf` conectado a la terminal (login interactivo, wrapper de la
 * consola). Devuelve el exit code de `cf`.
 */
function passthrough(args, { stdio = "inherit" } = {}) {
	if (!cfHome) {
		return Promise.reject(new Error(NOT_CONFIGURED));
	}
	return new Promise((resolve) => {
		const [bin, argv] = command(args);
		const child = spawn(bin, argv, { stdio, env: cfEnv(cfHome), windowsHide: true });
		child.on("error", () => resolve(127));
		child.on("exit", (code) => resolve(code === null ? 1 : code));
	});
}

/**
 * Login no interactivo dentro del CF_HOME del perfil.
 *
 * - password: `cf api` + `cf auth` con CF_USERNAME/CF_PASSWORD en el entorno.
 *   La contrasena no queda en la linea de comandos (visible en el
 *   administrador de tareas), que es lo que pasaba con `cf login -p`.
 * - sso: `cf login --sso-passcode` con el passcode que el usuario copio del
 *   browser. Sin stdin: si `cf` pregunta por un org, recibe EOF y lo saltea.
 *
 * Despues apunta al org/space del perfil, si los tiene (un perfil nuevo
 * todavia no los tiene: se eligen con lo que liste `targets`).
 */
async function login({ api, user, password, passcode, org, space }) {
	const last = (r) => (r.err || r.out || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ");

	if (passcode) {
		const res = await cf(["login", "-a", api, "--sso-passcode", passcode], 120000);
		if (!res.ok) return { ok: false, error: last(res) || "Passcode rechazado." };
	} else {
		const apiRes = await cf(["api", api], 60000);
		if (!apiRes.ok) return { ok: false, error: last(apiRes) };
		const res = await cf(["auth"], 120000, { CF_USERNAME: user, CF_PASSWORD: password });
		if (!res.ok) return { ok: false, error: last(res) || "Usuario o contrasena rechazados." };
	}

	// Si el org/space no existe (o el usuario no tiene acceso), la sesion igual
	// quedo hecha: se informa aparte para que se pueda listar y elegir otro.
	if (org && space) {
		const target = await setTarget(org, space);
		if (!target.ok) return { ok: true, targetError: target.error };
	}
	return { ok: true };
}

/**
 * PASO 1 - Verificar que el CLI existe y que hay una sesion activa.
 *
 * `cf target` falla si no hay login, asi que sirve de check y de fuente de
 * datos a la vez (api endpoint, usuario, org, space).
 */
async function checkLogin() {
	const version = await cf(["--version"], 15000);
	if (!version.ok) {
		return { ok: false, reason: "no-cli", hint: "El CLI `cf` no esta instalado o no esta en el PATH." };
	}

	const target = await cf(["target"], 30000);
	if (!target.ok) {
		return {
			ok: false,
			reason: "no-login",
			hint: "No hay sesion de CF en este perfil. Correr:  node bin/cf-proxy.js login <perfil>"
		};
	}

	// `cf target` imprime "clave: valor" por linea. Se parsea sin asumir orden.
	const field = (label) => {
		const m = target.out.match(new RegExp("^" + label + ":\\s*(.+)$", "im"));
		return m ? m[1].trim() : null;
	};

	const versionMatch = version.out.match(/version\s+(\S+)/i);

	return {
		ok: true,
		api: field("API endpoint"),
		user: field("user"),
		org: field("org"),
		space: field("space"),
		cliVersion: versionMatch ? versionMatch[1] : "?"
	};
}

/**
 * PASO 2b - Listar los orgs y spaces a los que el usuario tiene acceso.
 *
 * Se usa para el selector de la pagina: cambiar de subaccount sin reiniciar
 * el proxy ni salir a la terminal. Una sola pasada por la API v3, cruzando
 * spaces con sus orgs por guid.
 */
async function listTargets() {
	const orgs = await curlAll("/v3/organizations?per_page=100");
	if (!orgs.length) {
		return [];
	}

	const orgName = {};
	for (const o of orgs) {
		orgName[o.guid] = o.name;
	}

	const spaces = await curlAll("/v3/spaces?per_page=100");
	const byOrg = {};
	for (const s of spaces) {
		const guid = s.relationships?.organization?.data?.guid;
		if (!orgName[guid]) continue;
		(byOrg[guid] = byOrg[guid] || []).push(s.name);
	}

	return orgs
		.map((o) => ({ org: o.name, spaces: (byOrg[o.guid] || []).sort((a, b) => a.localeCompare(b)) }))
		.filter((o) => o.spaces.length)
		.sort((a, b) => a.org.localeCompare(b.org));
}

/**
 * PASO 2b - Spaces de UN org (el del perfil).
 *
 * El org queda fijo por perfil (una subcuenta = un perfil), asi que el
 * selector de la pagina solo necesita los spaces de ese org. Devuelve la misma
 * forma que listTargets: [{org, spaces}].
 */
async function listSpaces(org) {
	const orgs = await curlAll("/v3/organizations?names=" + encodeURIComponent(org));
	if (!orgs.length) {
		return [];
	}
	const spaces = await curlAll("/v3/spaces?per_page=100&organization_guids=" + orgs[0].guid);
	return [{ org, spaces: spaces.map((s) => s.name).sort((a, b) => a.localeCompare(b)) }];
}

/**
 * PASO 2b - Cambiar el target de CF.
 *
 * Afecta solo al CF_HOME del perfil: la terminal del usuario y los otros
 * proxies no se enteran. Quien lo llama tiene que rehacer el descubrimiento
 * de servicios; las credenciales del space anterior pueden no servir.
 */
async function setTarget(org, space) {
	const res = await cf(["target", "-o", org, "-s", space], 60000);
	if (!res.ok) {
		// `cf` manda el detalle por stdout o stderr segun la version.
		const why = (res.err || res.out || "").trim().split("\n").filter(Boolean).slice(-2).join(" ");
		return { ok: false, error: why || `No se pudo apuntar a ${org}/${space}.` };
	}
	return { ok: true };
}

/** GET paginado de la API v3 de CF: devuelve todos los `resources`. */
async function curlAll(firstUrl) {
	const out = [];
	let url = firstUrl;

	while (url) {
		const res = await cf(["curl", url], 60000);
		if (!res.out.includes("{")) break;

		let body;
		try {
			body = JSON.parse(res.out.slice(res.out.indexOf("{")));
		} catch (e) {
			break;
		}

		for (const r of body.resources || []) {
			out.push(r);
		}

		const next = body.pagination?.next?.href;
		url = next ? new URL(next).pathname + new URL(next).search : null;
	}

	return out;
}

/**
 * PASO 2a - Listar las instancias de servicio del space actual.
 *
 * Se usa la API v3 via `cf curl` en vez de parsear la tabla de `cf services`,
 * porque esa tabla tiene columnas de ancho variable (los nombres largos y la
 * columna "bound apps" la vuelven imparseable de forma confiable).
 */
async function listServiceInstances() {
	const guid = await currentSpaceGuid();
	if (!guid) {
		return [];
	}

	const instances = [];
	// Se piden los guids de plan y offering en `included` para poder cruzar
	// instancia -> plan -> offering. Sin `guid` en los fields no hay forma de unirlos.
	let url =
		"/v3/service_instances?space_guids=" + guid + "&per_page=100" +
		"&fields[service_plan]=guid,name,relationships.service_offering" +
		"&fields[service_plan.service_offering]=guid,name";

	// La API pagina: se sigue `pagination.next` hasta que no haya mas.
	while (url) {
		const res = await cf(["curl", url], 60000);
		if (!res.out.includes("{")) break;

		let body;
		try {
			body = JSON.parse(res.out.slice(res.out.indexOf("{")));
		} catch (e) {
			break;
		}

		// El nombre del offering (xsuaa / destination / connectivity) viene en el
		// bloque `included`, no en el recurso: se arma un indice para cruzarlo.
		const offeringById = {};
		for (const o of (body.included && body.included.service_offerings) || []) {
			offeringById[o.guid] = o.name;
		}

		const planToOffering = {};
		for (const p of (body.included && body.included.service_plans) || []) {
			const rel = p.relationships && p.relationships.service_offering;
			planToOffering[p.guid] = offeringById[rel && rel.data && rel.data.guid];
		}

		for (const r of body.resources || []) {
			const rel = r.relationships && r.relationships.service_plan;
			const planGuid = rel && rel.data && rel.data.guid;
			instances.push({ guid: r.guid, name: r.name, offering: planToOffering[planGuid] || null });
		}

		const next = body.pagination && body.pagination.next && body.pagination.next.href;
		url = next ? new URL(next).pathname + new URL(next).search : null;
	}

	return instances;
}

/** GUID del space actual, resuelto por nombre a partir del target. Nada hardcodeado. */
async function currentSpaceGuid() {
	const target = await checkLogin();
	if (!target.ok || !target.space) {
		return null;
	}

	const guidRes = await cf(["space", "--guid", target.space], 30000);
	const guid = guidRes.out.trim().split(/\r?\n/).pop().trim();
	return /^[0-9a-f-]{30,}$/i.test(guid) ? guid : null;
}

/** Recorre todas las paginas de un endpoint v3 y devuelve los `resources` concatenados. */
async function curlAllPages(firstUrl) {
	const resources = [];
	let url = firstUrl;

	while (url) {
		const res = await cf(["curl", url], 60000);
		if (!res.out.includes("{")) break;

		let body;
		try {
			body = JSON.parse(res.out.slice(res.out.indexOf("{")));
		} catch (e) {
			break;
		}

		resources.push(...(body.resources || []));

		const next = body.pagination && body.pagination.next && body.pagination.next.href;
		url = next ? new URL(next).pathname + new URL(next).search : null;
	}

	return resources;
}

/** PASO 2b - Nombres de las service keys de una instancia. */
async function listServiceKeys(instanceName) {
	const res = await cf(["service-keys", instanceName], 45000);
	if (!res.ok || /No service key/i.test(res.out)) return [];

	// La salida es una tabla; interesa la primera columna despues del header.
	const lines = res.out.split(/\r?\n/);
	const headerIdx = lines.findIndex((l) => /^name\s/i.test(l.trim()));
	if (headerIdx === -1) return [];

	return lines
		.slice(headerIdx + 1)
		.map((l) => l.trim().split(/\s{2,}/)[0])
		.filter((n) => n && !/^(FAILED|OK)$/i.test(n));
}

/**
 * PASO 3 - Leer las credenciales de una service key.
 *
 * `cf service-key <inst> <key>` imprime una linea de texto y despues el JSON.
 * Se recorta desde la primera llave.
 */
async function readServiceKey(instanceName, keyName) {
	const res = await cf(["service-key", instanceName, keyName], 45000);
	const start = res.out.indexOf("{");
	if (start === -1) return null;

	try {
		const parsed = JSON.parse(res.out.slice(start));
		// Segun version del CLI las credenciales vienen en la raiz o bajo `credentials`.
		return parsed.credentials || parsed;
	} catch (e) {
		return null;
	}
}

/** PASO 3b - Crear una service key (cuando la instancia no tiene ninguna usable). */
async function createServiceKey(instanceName, keyName) {
	const res = await cf(["create-service-key", instanceName, keyName], 90000);
	return res.ok || /already exists/i.test(res.out + res.err);
}

/**
 * PASO 4b - Apps en estado STARTED del space actual.
 *
 * Son las candidatas para abrir el tunel SSH hacia el Connectivity Proxy.
 * Cualquier app corriendo sirve: solo se usa como salto de red.
 */
async function listStartedApps() {
	const guid = await currentSpaceGuid();
	if (!guid) {
		return [];
	}

	const apps = await curlAllPages("/v3/apps?space_guids=" + guid + "&per_page=100");
	return apps.filter((a) => a.state === "STARTED").map((a) => a.name);
}

/** PASO 4b - Si una app acepta `cf ssh`. */
async function isSshEnabled(appName) {
	const res = await cf(["ssh-enabled", appName], 30000);
	return res.ok && /is enabled/i.test(res.out);
}

/**
 * PASO 4b - Abre un tunel `cf ssh -L` a traves de una app del space.
 *
 * El Connectivity Proxy solo es alcanzable desde adentro de CF. Un port-forward
 * por SSH a traves de cualquier app corriendo lo trae a localhost sin desplegar
 * nada nuevo. Devuelve el proceso hijo para poder cerrarlo al salir.
 */
function startTunnel({ appName, localPort, remoteHost, remotePort }) {
	const forward = `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`;

	if (!cfHome) {
		throw new Error(NOT_CONFIGURED);
	}
	// -k: no validar la host key (cambia por app). -N: solo port-forward, sin shell.
	const [bin, argv] = command(["ssh", "-k", "-N", "-L", forward, appName]);
	return spawn(bin, argv, {
		windowsHide: true,
		env: cfEnv(cfHome),
		stdio: ["ignore", "pipe", "pipe"]
	});
}

module.exports = {
	configure,
	passthrough,
	login,
	listSpaces,
	checkLogin,
	listTargets,
	setTarget,
	listServiceInstances,
	listServiceKeys,
	readServiceKey,
	createServiceKey,
	listStartedApps,
	isSshEnabled,
	startTunnel
};
