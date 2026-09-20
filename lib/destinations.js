/**
 * PASO 3 - Cliente del Destination Service de BTP.
 *
 * Dos responsabilidades:
 *   a) Pedir tokens a XSUAA (client_credentials) y cachearlos.
 *   b) Listar, resolver, crear, actualizar y eliminar destinations.
 *
 * "Resolver" quiere decir pedirle al servicio la config COMPLETA de una
 * destination: URL real del backend, tipo de auth y, cuando corresponde, las
 * credenciales ya materializadas (usuario/password o un token OAuth).
 *
 * Lectura y escritura comparten el mismo path del servicio y cambian solo el
 * verbo; ver el bloque ESCRITURA mas abajo para el detalle de POST vs PUT.
 */
const https = require("https");
const { URL } = require("url");

/** POST/GET JSON minimo sobre https, sin dependencias externas. */
function request(urlStr, { method = "GET", headers = {}, body = null, timeout = 30000 } = {}) {
	return new Promise((resolve, reject) => {
		const u = new URL(urlStr);
		const req = https.request(
			{
				hostname: u.hostname,
				port: u.port || 443,
				path: u.pathname + u.search,
				method,
				headers,
				timeout
			},
			(res) => {
				let data = "";
				res.on("data", (c) => (data += c));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
			}
		);
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("timeout"));
		});
		if (body) req.write(body);
		req.end();
	});
}

/**
 * Token de XSUAA por client_credentials.
 *
 * Se cachea en memoria y se renueva 60s antes de expirar, para no pedir uno
 * nuevo en cada request del proxy.
 */
function makeTokenProvider(creds) {
	let cached = null; // { token, expiresAt }

	return async function getToken() {
		if (cached && Date.now() < cached.expiresAt) {
			return cached.token;
		}

		const auth = Buffer.from(`${creds.clientid}:${creds.clientsecret}`).toString("base64");
		const res = await request(creds.url.replace(/\/+$/, "") + "/oauth/token", {
			method: "POST",
			headers: {
				authorization: `Basic ${auth}`,
				"content-type": "application/x-www-form-urlencoded"
			},
			body: "grant_type=client_credentials"
		});

		if (res.status !== 200) {
			throw new Error(`XSUAA respondio ${res.status} al pedir token: ${res.body.slice(0, 200)}`);
		}

		const parsed = JSON.parse(res.body);
		cached = {
			token: parsed.access_token,
			expiresAt: Date.now() + (parsed.expires_in - 60) * 1000
		};
		return cached.token;
	};
}

/** Cliente del Destination Service ya atado a unas credenciales. */
function makeDestinationClient(destCreds) {
	const getToken = makeTokenProvider(destCreds);
	const base = destCreds.uri.replace(/\/+$/, "") + "/destination-configuration/v1";

	/** Lista las destinations del subaccount (sin credenciales, solo metadata). */
	async function list() {
		const token = await getToken();
		const res = await request(`${base}/subaccountDestinations`, {
			headers: { authorization: `Bearer ${token}` }
		});

		if (res.status !== 200) {
			throw new Error(`No se pudieron listar destinations (HTTP ${res.status})`);
		}

		return JSON.parse(res.body).map((d) => ({
			name: d.Name,
			url: d.URL,
			auth: d.Authentication,
			proxyType: d.ProxyType,
			locationId: d.CloudConnectorLocationId || null
		}));
	}

	/**
	 * Resuelve UNA destination con sus credenciales materializadas.
	 * Se cachea: la respuesta puede incluir tokens con vencimiento propio.
	 *
	 * Si se pasa `userToken` (JWT del usuario logueado), va en el header
	 * `X-user-token`: el Destination Service lo usa para las destinations que
	 * necesitan contexto de usuario (OAuth2UserTokenExchange, SAML, JWTBearer)
	 * y lo ignora en las demas. Se cachea aparte, porque el resultado cambia.
	 */
	const cache = new Map();

	async function resolve(name, userToken = null) {
		const cacheKey = userToken ? `${name}|user` : name;
		const hit = cache.get(cacheKey);
		if (hit && Date.now() < hit.expiresAt) {
			return hit.value;
		}

		const token = await getToken();
		const headers = { authorization: `Bearer ${token}` };
		if (userToken) {
			headers["x-user-token"] = userToken;
		}
		const res = await request(`${base}/destinations/${encodeURIComponent(name)}`, { headers });

		if (res.status === 404) {
			throw new Error(`La destination \`${name}\` no existe en este subaccount.`);
		}
		if (res.status !== 200) {
			throw new Error(`No se pudo resolver \`${name}\` (HTTP ${res.status})`);
		}

		const parsed = JSON.parse(res.body);
		const value = {
			config: parsed.destinationConfiguration || {},
			authTokens: parsed.authTokens || []
		};

		// Si trae un token OAuth con expiracion, se respeta; si no, 5 min.
		const expiresIn = Number(value.authTokens[0]?.expires_in || 300);
		cache.set(cacheKey, { value, expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000 });

		return value;
	}


	// =========================================================================
	// ESCRITURA - crear y actualizar destinations a nivel subaccount
	// =========================================================================
	//
	// Importante sobre que endpoint se usa:
	//
	// El Destination Service expone la escritura en el MISMO path que la
	// lectura (`/destination-configuration/v1/subaccountDestinations`), pero
	// con otros verbos:
	//
	//   POST   /subaccountDestinations          crea una nueva
	//   PUT    /subaccountDestinations          actualiza una existente
	//   DELETE /subaccountDestinations/<nombre> borra una
	//
	// El POST falla con 409 si el nombre ya existe, y el PUT falla con 404 si
	// no existe. Esa asimetria es a proposito: hace imposible que un "crear"
	// pise una destination ajena por accidente.
	//
	// Las claves del payload son case-sensitive y van en PascalCase exacto
	// (`Name`, `URL`, `Authentication`, `ProxyType`). El servicio devuelve
	// objetos con `URL` y `url` a la vez, asi que no se puede normalizar a
	// minusculas sin perder informacion.

	/**
	 * Quita las propiedades en `null`.
	 *
	 * Es el contrato para ELIMINAR una propiedad en un update: como el merge
	 * conserva todo lo que no viene en el payload, hace falta una forma
	 * explicita de decir "esta sacala". Un `null` la deja fuera del payload y,
	 * como el PUT reemplaza el objeto entero, desaparece del subaccount.
	 */
	function dropNulls(obj) {
		const out = {};
		for (const [k, v] of Object.entries(obj)) {
			if (v !== null) {
				out[k] = v;
			}
		}
		return out;
	}

	/** Valida lo minimo que toda destination necesita antes de mandarla. */
	function validate(config) {
		if (!config || typeof config !== "object") {
			throw new Error("Se esperaba un objeto con la configuracion de la destination.");
		}
		if (!config.Name) {
			throw new Error("Falta `Name`: es la clave con la que se identifica la destination.");
		}
		if (!/^[A-Za-z0-9_\-.]+$/.test(config.Name)) {
			throw new Error(`\`${config.Name}\` no es un nombre valido (solo letras, numeros, _ - y .).`);
		}
		if (!config.URL) {
			throw new Error("Falta `URL`: sin eso la destination no apunta a ningun backend.");
		}
		if (!config.Type) {
			// El servicio asume HTTP, pero dejarlo implicito genera destinations
			// que se ven raras en el cockpit. Se pone explicito.
			config.Type = "HTTP";
		}
		if (!config.ProxyType) {
			// Idem: el cockpit pone Internet por default; el servicio, nada.
			config.ProxyType = "Internet";
		}
		if (!config.Authentication) {
			throw new Error("Falta `Authentication` (ej: NoAuthentication, BasicAuthentication, OAuth2ClientCredentials).");
		}
		return config;
	}

	/**
	 * Manda el payload al servicio con el verbo indicado.
	 *
	 * Se manda siempre como array de un elemento: el servicio acepta lote, y
	 * mandar un array de UNO es la unica forma de estar seguro de que no se
	 * toca ninguna otra destination.
	 *
	 * Como es un lote, el servicio responde 207 (Multi-Status) con el resultado
	 * de cada elemento adentro: `[{ name, status: "409", cause }]`. Verificado
	 * contra el servicio real: un duplicado NO da 409 al tope, da 207 con el
	 * 409 en el body. Aca se resuelve eso y se devuelve `status` ya efectivo,
	 * para que create/update comparen contra un numero y no contra un texto.
	 */
	async function write(method, config) {
		const token = await getToken();
		const body = JSON.stringify([config]);

		const res = await request(`${base}/subaccountDestinations`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body)
			},
			body
		});

		if (res.status === 207) {
			try {
				const items = JSON.parse(res.body);
				const mine = Array.isArray(items) && items.find((i) => i.name === config.Name);
				if (mine && mine.status) {
					return { ...res, status: Number(mine.status), cause: mine.cause || "" };
				}
			} catch (e) {
				// Body no parseable: se deja el 207 y falla mas abajo con el texto crudo.
			}
		}

		return res;
	}

	/**
	 * CONFIRMACION OBLIGATORIA antes de cualquier escritura.
	 *
	 * Toda escritura exige que el caller repita el nombre exacto de la
	 * destination en `confirm`. No es burocracia: este cliente escribe sobre
	 * el subaccount ENTERO, que puede ser de un cliente y tener cientos de
	 * destinations de otros proyectos.
	 *
	 * Se valida a nivel de dato, no con un prompt de consola, por dos razones:
	 *   - Estos metodos los llama el servidor HTTP, donde no hay TTY.
	 *   - Un `confirm` que viaja en el body hace imposible que un fetch suelto
	 *     dispare una escritura por accidente.
	 *
	 * `preview` devuelve, sin escribir nada, exactamente lo que se mandaria:
	 * es lo que hay que mostrarle al usuario para que confirme sobre algo real
	 * y no sobre una intencion.
	 */
	function requireConfirmation(action, name, confirm) {
		if (confirm !== name) {
			throw new Error(
				`CONFIRMACION REQUERIDA para ${action} \`${name}\` en el subaccount.\n` +
				`  Esta operacion escribe sobre el subaccount completo del target actual de CF.\n` +
				`  Antes de seguir: verificar el org/space con \`cf target\` y revisar el preview.\n` +
				`  Para confirmar, repetir el nombre exacto: { confirm: "${name}" }` +
				(confirm ? `\n  Recibido: "${confirm}" — no coincide.` : "")
			);
		}
	}

	/**
	 * Muestra que se escribiria, sin escribir.
	 *
	 * Para `update` incluye el diff propiedad por propiedad contra lo que hay
	 * hoy, que es la unica forma de ver si un cambio pisa algo que no se queria
	 * tocar.
	 */
	async function preview(action, config, { replace = false } = {}) {
		if (!config || !config.Name) {
			throw new Error("Falta `Name`.");
		}

		const current = await raw(config.Name);

		if (action === "create") {
			return {
				action: "create",
				name: config.Name,
				exists: current !== null,
				willSend: dropNulls(validate({ ...config })),
				warning: current
					? `Ya existe: create va a fallar con 409. Usar update.`
					: `Se va a CREAR \`${config.Name}\` en el subaccount del target actual de CF.`
			};
		}

		if (!current) {
			return {
				action: "update",
				name: config.Name,
				exists: false,
				willSend: null,
				warning: `No existe \`${config.Name}\`: update va a fallar con 404. Usar create.`
			};
		}

		const willSend = dropNulls(replace ? validate({ ...config }) : validate({ ...current, ...config }));

		// Diff sobre la union de claves. Una propiedad que desaparece se marca
		// distinto segun el motivo: "(SE QUITA)" si el caller la pidio en null,
		// "(SE PIERDE)" si se va por un replace:true que no la incluyo.
		const changes = [];
		for (const k of new Set([...Object.keys(current), ...Object.keys(willSend)])) {
			const before = current[k];
			const after = willSend[k];
			if (before !== after) {
				changes.push({
					property: k,
					before: before === undefined ? "(no estaba)" : before,
					after: after !== undefined ? after : (config[k] === null ? "(SE QUITA)" : "(SE PIERDE)")
				});
			}
		}
		const removed = changes.filter((c) => c.after === "(SE QUITA)").length;
		const lost = changes.filter((c) => c.after === "(SE PIERDE)").length;

		return {
			action: "update",
			name: config.Name,
			exists: true,
			replace,
			changes,
			willSend,
			warning: changes.length
				? `Se van a modificar ${changes.length} propiedad(es) de \`${config.Name}\`.` +
				  (removed ? ` Se QUITAN ${removed}.` : "") +
				  (lost ? " ATENCION: hay propiedades que se PIERDEN por reemplazo completo." : "")
				: `Sin cambios: el payload es identico a lo que ya esta guardado.`
		};
	}

	/**
	 * Crea una destination nueva a nivel subaccount.
	 *
	 * Falla si ya existe: para modificar una existente hay que usar `update`,
	 * de forma explicita. Es deliberado — un "crear" que silenciosamente pisa
	 * lo que habia es como se borran destinations de otros proyectos sin darse
	 * cuenta.
	 */
	async function create(config, { confirm = null } = {}) {
		const payload = dropNulls(validate({ ...config }));

		// PASO 1 - Nada se escribe sin confirmacion explicita del nombre.
		requireConfirmation("CREAR", payload.Name, confirm);

		// PASO 2 - Recien aca se escribe.
		const res = await write("POST", payload);

		if (res.status === 409) {
			throw new Error(
				`La destination \`${payload.Name}\` ya existe en este subaccount. ` +
				"Usar update si la intencion es modificarla."
			);
		}
		if (res.status !== 201 && res.status !== 200) {
			throw new Error(`No se pudo crear \`${payload.Name}\` (HTTP ${res.status}): ${res.cause || res.body.slice(0, 300)}`);
		}

		// La config resuelta que estaba cacheada ya no vale.
		invalidate(payload.Name);

		return { name: payload.Name, created: true };
	}

	/**
	 * Actualiza una destination existente a nivel subaccount.
	 *
	 * El PUT reemplaza el objeto COMPLETO: las propiedades que no van en el
	 * payload se pierden. Por eso se lee la actual primero y se mergea, salvo
	 * que se pida `replace: true` de forma explicita.
	 */
	async function update(config, { replace = false, confirm = null } = {}) {
		if (!config || !config.Name) {
			throw new Error("Falta `Name`: es la destination que se va a actualizar.");
		}

		// PASO 1 - Nada se escribe sin confirmacion explicita del nombre.
		requireConfirmation(replace ? "REEMPLAZAR" : "ACTUALIZAR", config.Name, confirm);

		let payload;

		if (replace) {
			// Reemplazo total: lo que se manda es exactamente lo que queda.
			payload = dropNulls(validate({ ...config }));
		} else {
			// Merge sobre la actual, para no perder propiedades que no se tocan.
			const current = await raw(config.Name);
			if (!current) {
				throw new Error(
					`La destination \`${config.Name}\` no existe en este subaccount. ` +
					"Usar create si la intencion es crearla."
				);
			}
			// Merge; lo que viene en null se quita (ver dropNulls).
			payload = dropNulls(validate({ ...current, ...config }));
		}

		const res = await write("PUT", payload);

		if (res.status === 404) {
			throw new Error(`La destination \`${payload.Name}\` no existe en este subaccount.`);
		}
		if (res.status !== 200 && res.status !== 201) {
			throw new Error(`No se pudo actualizar \`${payload.Name}\` (HTTP ${res.status}): ${res.cause || res.body.slice(0, 300)}`);
		}

		invalidate(payload.Name);

		return { name: payload.Name, updated: true };
	}

	/**
	 * Elimina una destination del subaccount.
	 *
	 * Antes de borrar se lee la definicion completa y se devuelve como
	 * `backup`: es lo unico que permite recrearla (con `create`) si el borrado
	 * fue un error. El Destination Service no tiene papelera ni deshacer.
	 *
	 * El DELETE es por nombre, sobre la ruta puntual: no puede alcanzar a
	 * ninguna otra destination del subaccount.
	 */
	async function remove(name, { confirm = null } = {}) {
		if (!name) {
			throw new Error("Falta el nombre de la destination a eliminar.");
		}

		// PASO 1 - Nada se borra sin confirmacion explicita del nombre.
		requireConfirmation("ELIMINAR", name, confirm);

		// PASO 2 - Backup de la definicion tal cual esta guardada.
		const backup = await raw(name);
		if (!backup) {
			throw new Error(`La destination \`${name}\` no existe en este subaccount.`);
		}

		// PASO 3 - Borrado puntual.
		const token = await getToken();
		const res = await request(`${base}/subaccountDestinations/${encodeURIComponent(name)}`, {
			method: "DELETE",
			headers: { authorization: `Bearer ${token}` }
		});

		if (res.status !== 200 && res.status !== 204) {
			throw new Error(`No se pudo eliminar \`${name}\` (HTTP ${res.status}): ${res.body.slice(0, 300)}`);
		}

		invalidate(name);

		return { name, deleted: true, backup };
	}

	/**
	 * Lee la definicion CRUDA de una destination del subaccount.
	 *
	 * Distinto de `resolve`: eso devuelve la config materializada por el
	 * runtime (con tokens ya emitidos). Aca hace falta la definicion tal cual
	 * esta guardada, que es lo unico que se puede volver a mandar en un PUT.
	 *
	 * Devuelve null si no existe.
	 */
	async function raw(name) {
		const token = await getToken();
		const res = await request(`${base}/subaccountDestinations/${encodeURIComponent(name)}`, {
			headers: { authorization: `Bearer ${token}` }
		});

		if (res.status === 404) {
			return null;
		}
		if (res.status !== 200) {
			throw new Error(`No se pudo leer la definicion de \`${name}\` (HTTP ${res.status})`);
		}

		return JSON.parse(res.body);
	}

	/**
	 * Saca una destination del cache de `resolve`.
	 *
	 * Hace falta despues de cada escritura: el cache guarda hasta 5 minutos, y
	 * sin esto el proxy seguiria usando la definicion vieja despues de un
	 * update — un sintoma dificil de diagnosticar.
	 */
	function invalidate(name) {
		cache.delete(name);
		cache.delete(`${name}|user`);
	}

	return { list, resolve, raw, preview, create, update, remove, invalidate };
}

module.exports = { makeDestinationClient, makeTokenProvider, request };
