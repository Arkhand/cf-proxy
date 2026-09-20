/**
 * PASO 2 y 3 - Descubrimiento automatico de los servicios que hacen falta.
 *
 * La idea central: el usuario no tiene que saber que instancias existen en su
 * subaccount ni como se llaman. Esta capa las busca, prueba cual sirve, y
 * devuelve credenciales listas para usar.
 *
 * Que hace falta y para que:
 *   - `destination`  : leer la lista de destinations y resolver sus credenciales.
 *   - `connectivity` : solo para destinations OnPremise (ProxyType=OnPremise).
 *                      Opcional: si no hay, se avisa y se sigue con las de Internet.
 *   - `xsuaa`        : solo para PrincipalPropagation (login de usuario).
 *                      Opcional, y con una condicion: tiene que ser el XSUAA
 *                      PROPIO (mta.yaml), porque el de otra app no acepta
 *                      redirect a localhost.
 *
 * Orden de busqueda:
 *   1. Las instancias PROPIAS, por nombre exacto (las crea mta.yaml).
 *      Si estan, se usan directo: no se revisa nada mas del space.
 *   2. Si no estan, cualquier otra instancia del mismo offering que tenga una
 *      key usable (solo para destination y connectivity; xsuaa no admite esto).
 */
const cf = require("./cf");

/**
 * Nombres fijos de lo que despliega mta.yaml. Son la unica convencion
 * de la herramienta: todo lo demas se descubre.
 */
const OWN = {
	destination: "cf-dest-destination",
	connectivity: "cf-dest-connectivity",
	xsuaa: "cf-dest-xsuaa",
	sshApp: "cf-dest-app",
	key: "cf-dest-key"
};

/**
 * Una service key de `destination` sirve si trae clientid/clientsecret/url/uri.
 * Las keys de tipo "content" (usadas para subir destinations) NO sirven:
 * traen solo `content_endpoint` y hay que descartarlas.
 */
function isUsableDestinationKey(creds) {
	return Boolean(creds && creds.clientid && creds.clientsecret && creds.url && creds.uri);
}

/** Una key de `connectivity` sirve si trae los datos del proxy on-premise. */
function isUsableConnectivityKey(creds) {
	return Boolean(creds && creds.clientid && creds.clientsecret && creds.url && creds.onpremise_proxy_host);
}

/** Una key de `xsuaa` sirve si trae el cliente OAuth y la URL del tenant. */
function isUsableXsuaaKey(creds) {
	return Boolean(creds && creds.clientid && creds.clientsecret && creds.url);
}

/** Busca una key usable dentro de UNA instancia: primero las existentes, despues creando. */
async function keyFromInstance(inst, isUsable, allowCreate, log) {
	for (const keyName of await cf.listServiceKeys(inst.name)) {
		const creds = await cf.readServiceKey(inst.name, keyName);
		if (isUsable(creds)) {
			return { found: true, instance: inst.name, key: keyName, creds, created: false };
		}
	}

	if (!allowCreate) {
		return { found: false };
	}

	log(`  Creando service key ${OWN.key} en ${inst.name}...`);
	if (await cf.createServiceKey(inst.name, OWN.key)) {
		const creds = await cf.readServiceKey(inst.name, OWN.key);
		if (isUsable(creds)) {
			return { found: true, instance: inst.name, key: OWN.key, creds, created: true };
		}
	}
	return { found: false };
}

/**
 * Credenciales para un offering.
 *
 *   1. Si existe la instancia propia (nombre exacto), se usa esa y listo.
 *   2. Si no, se recorren las demas instancias del offering hasta encontrar
 *      una key usable (o crear una, con --create-keys).
 */
async function findCredentials(instances, offering, isUsable, allowCreate, log) {
	const candidates = instances.filter((i) => i.offering === offering);

	if (candidates.length === 0) {
		return { found: false, reason: `No hay instancias de \`${offering}\` en este space.` };
	}

	// --- 1. Instancia propia ---------------------------------------------------
	const own = candidates.find((i) => i.name === OWN[offering]);
	if (own) {
		// La key del MTA puede estar aun creandose justo despues del deploy;
		// si no esta, se intenta crear sin necesidad de --create-keys.
		const result = await keyFromInstance(own, isUsable, true, log);
		if (result.found) {
			log(`  OK  ${offering}: instancia propia ${own.name} / ${result.key}`);
			return { ...result, own: true };
		}
		log(`  --  ${own.name} existe pero no tiene una key usable; se busca otra instancia.`);
	}

	// --- 2. Cualquier otra instancia ------------------------------------------
	const others = candidates.filter((i) => i !== own);
	log(`  Sin instancia propia de \`${offering}\`; revisando ${others.length} existente(s)...`);

	for (const inst of others) {
		const result = await keyFromInstance(inst, isUsable, false, log);
		if (result.found) {
			log(`  OK  ${offering}: reutilizando ${inst.name} / ${result.key}`);
			return { ...result, own: false };
		}
	}

	if (allowCreate) {
		for (const inst of others) {
			const result = await keyFromInstance(inst, isUsable, true, log);
			if (result.found) {
				log(`  OK  ${offering}: key creada en ${inst.name}`);
				return { ...result, own: false };
			}
		}
	}

	return {
		found: false,
		reason:
			`Ninguna instancia de \`${offering}\` tiene una key usable.\n` +
			"     Opciones: npm run deploy (crea las propias) o --create-keys (crea una en las existentes)."
	};
}

/**
 * XSUAA para el login de usuario.
 *
 * A diferencia de destination/connectivity, aca NO vale cualquiera: el cliente
 * tiene que tener redirect-uris hacia localhost, y eso solo lo cumple el propio
 * (mta.yaml). Se acepta otro unicamente si se indica con --xsuaa.
 */
async function findXsuaa(instances, { preferred, log }) {
	const all = instances.filter((i) => i.offering === "xsuaa");
	const wanted = preferred || OWN.xsuaa;
	const inst = all.find((i) => i.name === wanted);

	if (!inst) {
		return {
			found: false,
			reason: preferred
				? `No existe la instancia de xsuaa \`${preferred}\` en este space.`
				: `Hay ${all.length} instancia(s) de xsuaa, pero no la propia (\`${OWN.xsuaa}\`).\n` +
				  "     Las de otras apps no aceptan redirect a localhost. Desplegar mta.yaml: npm run deploy"
		};
	}

	const result = await keyFromInstance(inst, isUsableXsuaaKey, true, log);
	if (!result.found) {
		return { found: false, reason: `\`${inst.name}\` existe pero no se pudo obtener una key usable.` };
	}

	log(`  OK  xsuaa: ${inst.name} / ${result.key}`);
	return { ...result, own: !preferred };
}

/**
 * Punto de entrada del descubrimiento.
 * Devuelve destination (obligatorio), connectivity (opcional) y xsuaa (opcional).
 */
async function discover({ allowCreate = false, preferredXsuaa = null, log = console.log } = {}) {
	log("\n[2/6] Buscando instancias de servicio en el space...");
	const instances = await cf.listServiceInstances();

	if (instances.length === 0) {
		return { ok: false, error: "No se encontraron instancias de servicio en el space actual." };
	}

	const byOffering = {};
	for (const i of instances) {
		byOffering[i.offering] = (byOffering[i.offering] || 0) + 1;
	}
	log(`  ${instances.length} instancia(s): ` + Object.entries(byOffering).map(([k, v]) => `${k}=${v}`).join(", "));

	const ownNames = Object.values(OWN);
	const ownFound = instances.filter((i) => ownNames.includes(i.name)).map((i) => i.name);
	log(ownFound.length
		? `  Propias (del MTA): ${ownFound.join(", ")}`
		: "  Sin instancias propias (npm run deploy las crea); se reutilizan las existentes.");

	// --- destination: obligatorio -------------------------------------------
	log("\n[3/6] Obteniendo credenciales...");
	const dest = await findCredentials(instances, "destination", isUsableDestinationKey, allowCreate, log);

	if (!dest.found) {
		return { ok: false, error: `No se pudo usar el servicio \`destination\`.\n     ${dest.reason}` };
	}

	// --- connectivity: opcional (solo para OnPremise) ------------------------
	const conn = await findCredentials(instances, "connectivity", isUsableConnectivityKey, allowCreate, log);

	if (!conn.found) {
		log(`  --  sin \`connectivity\`: las destinations OnPremise no van a funcionar.`);
		log(`      (${conn.reason.split("\n")[0]})`);
	}

	// --- xsuaa: opcional (solo para PrincipalPropagation) ---------------------
	const xsuaa = await findXsuaa(instances, { preferred: preferredXsuaa, log });

	if (!xsuaa.found) {
		log(`  --  sin xsuaa propio: las destinations PrincipalPropagation no van a funcionar.`);
		log(`      ${xsuaa.reason.replace(/\n\s*/g, "\n      ")}`);
	}

	return {
		ok: true,
		destination: dest,
		connectivity: conn.found ? conn : null,
		xsuaa: xsuaa.found ? xsuaa : null,
		xsuaaReason: xsuaa.found ? null : xsuaa.reason
	};
}

module.exports = { discover, OWN };
