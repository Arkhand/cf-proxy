/**
 * PASO 1 y 2 - Todo lo que se habla con el `cf` CLI.
 *
 * Este modulo es el unico que ejecuta `cf`. El resto de la solucion recibe
 * datos ya normalizados y no sabe que existe un CLI por debajo.
 *
 * Principio de diseno: NADA hardcodeado. No se asume ningun nombre de
 * instancia, ni de org, ni de space. Todo se descubre preguntandole a CF,
 * para que la misma herramienta sirva en cualquier subaccount.
 */
const { execFile, spawn } = require("child_process");
const { URL } = require("url");

/** Ejecutable del CLI. En Windows hay que nombrar el .exe: sin shell, execFile no prueba extensiones. */
const CF_BIN = process.platform === "win32" ? "cf.exe" : "cf";

/** Ejecuta un comando `cf` y devuelve stdout. No tira: devuelve {ok, out}. */
function cf(args, timeout = 60000) {
	return new Promise((resolve) => {
		// Sin `shell: true` a proposito: los argumentos van literales y el shell
		// no puede romper el `&` de las query strings de `cf curl`.
		execFile(CF_BIN, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
			resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || (err && err.message) || "") });
		});
	});
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
			hint: "No hay sesion de CF. Correr:  cf login -a <api-endpoint> --sso"
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

	// -k: no validar la host key (cambia por app). -N: solo port-forward, sin shell.
	return spawn(CF_BIN, ["ssh", "-k", "-N", "-L", forward, appName], {
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"]
	});
}

module.exports = {
	checkLogin,
	listServiceInstances,
	listServiceKeys,
	readServiceKey,
	createServiceKey,
	listStartedApps,
	isSshEnabled,
	startTunnel
};
