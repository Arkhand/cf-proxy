/**
 * PASO 4 - El proxy local.
 *
 * Recibe requests en localhost y los reenvia al backend real de la destination,
 * aplicando la autenticacion que esa destination declare.
 *
 * Ruteo por path: el primer segmento de la URL es el nombre de la destination.
 *
 *     http://localhost:3100/s4dt/sap/opu/odata/...
 *                          └────┘ └──────────────┘
 *                        destination   path real
 *
 * Asi un solo proceso sirve a todas las destinations del subaccount, sin
 * configuracion previa: se descubren solas.
 */
const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

/** Pagina de diagnostico (UI5) que se sirve en `/`. Se lee en cada request para poder editarla sin reiniciar. */
const UI_PATH = path.resolve(__dirname, "..", "webapp", "index.html");

/** Nombres de propiedades que se consideran secreto. La comparten maskSecrets y omitSecrets. */
const SECRET_KEY = /password|secret|^value$|token$|^http_header_value$/i;

/**
 * Oculta valores sensibles de un objeto (recursivo), salvo que se pida verlos.
 * Se aplica al JSON de detalle de una destination antes de mandarlo al browser.
 */
function maskSecrets(value, reveal) {
	if (reveal || value === null || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((v) => maskSecrets(v, reveal));
	}
	const out = {};
	for (const [k, v] of Object.entries(value)) {
		const sensitive = SECRET_KEY.test(k) && typeof v === "string";
		out[k] = sensitive ? v.slice(0, 6) + "…(oculto, usar ?reveal=1)" : maskSecrets(v, reveal);
	}
	return out;
}

/**
 * Oculta del todo los valores secretos de un objeto plano.
 *
 * `maskSecrets` deja los primeros 6 caracteres y sugiere `?reveal=1`: sirve
 * para el detalle. En el preview y en el backup de un delete no hay reveal, y
 * 6 caracteres pueden ser una contrasena entera; aca no se muestra nada.
 */
function hideSecrets(value) {
	const out = {};
	for (const [k, v] of Object.entries(value)) {
		out[k] = SECRET_KEY.test(k) && typeof v === "string" ? "…(oculto)" : v;
	}
	return out;
}

/**
 * Saca del objeto las propiedades secretas (en vez de enmascararlas).
 *
 * Se usa para precargar el editor de la pagina: un valor enmascarado que
 * vuelve en un update pisaria el secreto real con el texto "…(oculto)". Si el
 * campo directamente no esta, el merge del update lo conserva tal cual.
 */
function omitSecrets(value) {
	const out = {};
	for (const [k, v] of Object.entries(value)) {
		if (!(SECRET_KEY.test(k) && typeof v === "string")) {
			out[k] = v;
		}
	}
	return out;
}

/**
 * Lee el body de un request como JSON.
 *
 * Exige `content-type: application/json` a proposito: con ese header el
 * browser hace preflight CORS antes de un POST cross-origin, y como el proxy
 * no responde CORS, una pagina de OTRO origen no puede disparar escrituras
 * contra el subaccount. Un POST con text/plain no tiene preflight, y por eso
 * se rechaza aunque el contenido sea JSON valido.
 */
function readJsonBody(req, limit = 256 * 1024) {
	return new Promise((resolve, reject) => {
		if (!/^application\/json/i.test(req.headers["content-type"] || "")) {
			return reject(new Error("El body tiene que ser JSON (content-type: application/json)."));
		}
		let data = "";
		req.on("data", (c) => {
			data += c;
			if (data.length > limit) {
				req.destroy();
				reject(new Error("Body demasiado grande."));
			}
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch (e) {
				reject(new Error(`JSON invalido: ${e.message}`));
			}
		});
		req.on("error", reject);
	});
}

/**
 * Arma el detalle de una destination con la misma forma que devuelve
 * `getDestination()` de `@sap-cloud-sdk/connectivity`, para que lo que se ve
 * en la pagina sea lo mismo que se veria desde una app CAP/Node.
 */
function toSdkShape(name, resolved) {
	const cfg = resolved.config;
	return {
		name: cfg.Name || name,
		url: cfg.URL,
		authentication: cfg.Authentication,
		proxyType: cfg.ProxyType,
		cloudConnectorLocationId: cfg.CloudConnectorLocationId || null,
		username: cfg.User || null,
		password: cfg.Password || null,
		sapClient: cfg["sap-client"] || null,
		isTrustingAllCertificates: cfg.TrustAll === "TRUE",
		authTokens: resolved.authTokens,
		originalProperties: cfg
	};
}

/**
 * Texto legible para un error de red.
 *
 * Node a veces devuelve un AggregateError con `message` vacio (cuando prueba
 * varias IPs y fallan todas); en ese caso se buscan los codigos adentro.
 */
function describeError(e) {
	if (e && Array.isArray(e.errors) && e.errors.length) {
		return e.errors.map((x) => x.code || x.message).filter(Boolean).join(", ");
	}
	return (e && (e.code || e.message)) || String(e);
}

/**
 * Prueba si un host:port acepta conexiones TCP.
 *
 * Se usa al arrancar para saber si el Connectivity Proxy es alcanzable desde
 * esta red, en vez de descubrirlo con un timeout de 2 minutos en el primer request.
 */
function probeTcp(host, port, timeoutMs = 5000) {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port: Number(port), timeout: timeoutMs });
		const done = (ok, why) => {
			socket.destroy();
			resolve({ ok, why: why || null });
		};
		socket.on("connect", () => done(true));
		socket.on("timeout", () => done(false, "timeout"));
		socket.on("error", (e) => done(false, describeError(e)));
	});
}

/** Tipos de auth que el Destination Service solo resuelve con un usuario (X-user-token). */
const USER_AUTH_TYPES = ["OAuth2UserTokenExchange", "OAuth2JWTBearer", "OAuth2SAMLBearerAssertion", "SAMLAssertion"];

/**
 * Aplica la autenticacion de la destination a los headers salientes.
 *
 * Cada tipo se maneja distinto:
 *   - BasicAuthentication      : header Authorization armado con User/Password.
 *   - OAuth2*                  : el servicio ya devolvio un token en authTokens.
 *   - NoAuthentication         : nada.
 *   - PrincipalPropagation     : el JWT del usuario logueado (lib/auth.js) viaja
 *                                en SAP-Connectivity-Authentication; el Cloud
 *                                Connector lo cambia por un X.509 de ese usuario.
 *
 * `userToken` es el JWT del usuario logueado (o null). `loginHint` es el texto
 * a mostrar cuando falta: depende de si hay XSUAA propio o no.
 */
function applyAuth(headers, resolved, { userToken = null, loginHint = "" } = {}) {
	const cfg = resolved.config;
	const auth = cfg.Authentication;

	if (auth === "BasicAuthentication") {
		// El servicio devuelve User y Password ya desencriptados.
		const basic = Buffer.from(`${cfg.User}:${cfg.Password}`).toString("base64");
		headers.authorization = `Basic ${basic}`;
		return { ok: true };
	}

	if (auth === "NoAuthentication" || !auth) {
		return { ok: true };
	}

	if (String(auth).startsWith("OAuth2")) {
		const token = resolved.authTokens?.[0];

		if (!token || token.error) {
			// Los tipos con usuario fallan si no hay login: el servicio no tiene
			// a quien intercambiar. Se avisa eso en vez del error generico.
			if (USER_AUTH_TYPES.includes(auth) && !userToken) {
				return { ok: false, status: 401, error: `${auth} necesita un usuario logueado. ${loginHint}` };
			}
			return {
				ok: false,
				error:
					`La destination usa ${auth} pero el servicio no devolvio un token usable.` +
					(token?.error ? ` (${token.error})` : "")
			};
		}

		headers.authorization = `${token.type || "Bearer"} ${token.value}`;
		return { ok: true };
	}

	if (auth === "PrincipalPropagation") {
		if (!userToken) {
			return {
				ok: false,
				status: 401,
				error: `PrincipalPropagation necesita el JWT del usuario final. ${loginHint}`
			};
		}
		// El Connectivity Proxy reenvia este header al Cloud Connector, que
		// deriva de el el certificado X.509 de corta vida del usuario.
		headers["sap-connectivity-authentication"] = `Bearer ${userToken}`;
		return { ok: true };
	}

	return { ok: false, error: `Tipo de autenticacion no soportado: ${auth}` };
}

/**
 * Decide a donde y como se manda el request.
 *
 * Internet   -> directo al host de la destination.
 * OnPremise  -> a traves del Connectivity Proxy, que es quien habla con el
 *               Cloud Connector. Requiere headers especiales y un tunel HTTP.
 *
 * `connectivity` es { proxyHost, proxyPort } ya verificado por server.js
 * (puede apuntar al host real o a un tunel local), o null si no hay.
 */
function buildTarget(resolved, connectivity, connToken, connectivityNote) {
	const cfg = resolved.config;
	const targetUrl = new URL(cfg.URL);

	// --- Caso simple: backend accesible por internet -------------------------
	if (cfg.ProxyType !== "OnPremise") {
		return {
			ok: true,
			onPremise: false,
			hostname: targetUrl.hostname,
			port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
			protocol: targetUrl.protocol,
			basePath: targetUrl.pathname.replace(/\/+$/, "")
		};
	}

	// --- Caso on-premise: hace falta el Connectivity Proxy -------------------
	if (!connectivity) {
		return {
			ok: false,
			error: "Esta destination es OnPremise y requiere el Connectivity Proxy. " + connectivityNote
		};
	}

	return {
		ok: true,
		onPremise: true,
		// El request va al proxy, no al host final.
		hostname: connectivity.proxyHost,
		port: connectivity.proxyPort,
		protocol: "http:",
		basePath: targetUrl.pathname.replace(/\/+$/, ""),
		// El host final viaja en la URL absoluta del request.
		absoluteHost: targetUrl.origin,
		extraHeaders: {
			"proxy-authorization": `Bearer ${connToken}`,
			...(cfg.CloudConnectorLocationId ? { "sap-connectivity-scc-location_id": cfg.CloudConnectorLocationId } : {})
		}
	};
}

/**
 * Crea el servidor HTTP del proxy.
 *
 * `auth` es el manejador de login de lib/auth.js (siempre presente: si no hay
 * XSUAA propio es un objeto nulo con `configured: false`).
 * `cfTarget` es { org, space, user } de la sesion de CF, solo informativo.
 */
function createProxyServer({ destClient, connectivity, connTokenProvider, connectivityNote, auth, cfTarget = null, log }) {
	// Texto unico para "falta login", usado en los 401 y en la pagina.
	const loginHint = auth.configured
		? "Iniciar sesion en /__login (o arrancar con --login)."
		: auth.reason;

	return http.createServer(async (req, res) => {
		const send = (status, payload) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(payload, null, 2));
		};
		const redirect = (location) => {
			res.writeHead(302, { location });
			res.end();
		};

		try {
			const reqUrl = new URL(req.url, "http://localhost");

			// --- Pagina de diagnostico (UI5) -------------------------------------
			if (reqUrl.pathname === "/" || reqUrl.pathname === "/__ui") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				return res.end(fs.readFileSync(UI_PATH, "utf8"));
			}

			// --- Login de usuario (PASO 4): el proxy es el callback de XSUAA -----
			if (reqUrl.pathname === "/__login") {
				if (!auth.configured) {
					return send(501, { error: auth.reason });
				}
				return redirect(auth.authorizeUrl());
			}

			if (reqUrl.pathname === "/__callback") {
				const oauthError = reqUrl.searchParams.get("error");
				if (oauthError) {
					return send(400, { error: `XSUAA devolvio "${oauthError}"`, detail: reqUrl.searchParams.get("error_description") });
				}
				try {
					const user = await auth.handleCallback({
						code: reqUrl.searchParams.get("code"),
						state: reqUrl.searchParams.get("state")
					});
					log(`  OK  sesion iniciada: ${user.name}${user.email ? ` <${user.email}>` : ""}`);
					return redirect("/");
				} catch (e) {
					return send(500, { error: `No se pudo completar el login: ${e.message}` });
				}
			}

			if (reqUrl.pathname === "/__logout") {
				auth.logout();
				log("  --  sesion cerrada");
				return redirect("/");
			}

			// El JWT del usuario, si hay sesion. Se renueva solo con el refresh token.
			const userToken = auth.configured ? await auth.getUserToken() : null;

			// --- Endpoint propio: detalle de UNA destination (forma del Cloud SDK)
			if (reqUrl.pathname.startsWith("/__destination/")) {
				const name = decodeURIComponent(reqUrl.pathname.slice("/__destination/".length));
				const reveal = reqUrl.searchParams.get("reveal") === "1";
				try {
					const resolved = await destClient.resolve(name, userToken);
					return send(200, maskSecrets(toSdkShape(name, resolved), reveal));
				} catch (e) {
					return send(404, { error: e.message });
				}
			}

			// --- Endpoints propios de EDICION: crear / actualizar ---------------
			//
			// Toda escritura son dos requests desde la pagina: primero `preview`
			// (no escribe, devuelve el diff) y despues la operacion real, que
			// exige `confirm` con el nombre exacto. El guard vive en
			// lib/destinations.js; aca solo se traduce HTTP -> funcion.
			//
			//   GET  /__destinations/<nombre>/raw   definicion guardada, sin secretos (precarga del editor)
			//   POST /__destinations/preview        { action, config, replace } -> diff, no escribe
			//   POST /__destinations                { config, confirm }         -> crea
			//   PUT  /__destinations/<nombre>       { config, confirm, replace } -> actualiza
			//   DELETE /__destinations/<nombre>     { confirm }                  -> elimina (devuelve backup)
			//
			// Van ANTES del ruteo generico: si no, `/__destinations/preview` se
			// tomaria como la destination "__destinations".
			const isEdit = reqUrl.pathname.startsWith("/__destinations/") ||
				(reqUrl.pathname === "/__destinations" && req.method !== "GET");

			if (isEdit) {
				try {
					const rawMatch = reqUrl.pathname.match(/^\/__destinations\/([^/]+)\/raw$/);
					if (rawMatch && req.method === "GET") {
						const name = decodeURIComponent(rawMatch[1]);
						const def = await destClient.raw(name);
						if (!def) {
							return send(404, { error: `La destination \`${name}\` no existe en este subaccount.` });
						}
						return send(200, omitSecrets(def));
					}

					if (reqUrl.pathname === "/__destinations/preview" && req.method === "POST") {
						const { action, config, replace } = await readJsonBody(req);
						const pv = await destClient.preview(action, config, { replace: Boolean(replace) });

						// El diff trae valores reales de la definicion guardada: los de
						// propiedades secretas se ocultan antes de mandarlos al browser.
						// Los marcadores "(no estaba)" / "(SE PIERDE)" se dejan ver.
						const hide = (v) => (typeof v === "string" && !/^\(/.test(v) ? "…(oculto)" : v);
						if (pv.changes) {
							pv.changes = pv.changes.map((c) =>
								SECRET_KEY.test(c.property) ? { ...c, before: hide(c.before), after: hide(c.after) } : c
							);
						}
						if (pv.willSend) {
							pv.willSend = hideSecrets(pv.willSend);
						}
						return send(200, pv);
					}

					if (reqUrl.pathname === "/__destinations" && req.method === "POST") {
						const { config, confirm } = await readJsonBody(req);
						const result = await destClient.create(config, { confirm });
						log(`  OK  destination creada: ${result.name}`);
						return send(201, result);
					}

					const updMatch = reqUrl.pathname.match(/^\/__destinations\/([^/]+)$/);
					if (updMatch && req.method === "PUT") {
						const name = decodeURIComponent(updMatch[1]);
						const { config, confirm, replace } = await readJsonBody(req);
						// El nombre viene de la URL: el body no puede renombrar.
						const result = await destClient.update({ ...config, Name: name }, { confirm, replace: Boolean(replace) });
						log(`  OK  destination actualizada: ${result.name}`);
						return send(200, result);
					}

					if (updMatch && req.method === "DELETE") {
						const name = decodeURIComponent(updMatch[1]);
						const { confirm } = await readJsonBody(req);
						const result = await destClient.remove(name, { confirm });
						// El backup queda tambien en la consola del proxy (sin secretos):
						// si la pagina se cerro, es lo que permite recrearla con create.
						log(`  !!  destination ELIMINADA: ${result.name}. Definicion para recrearla (sin secretos):`);
						log(`      ${JSON.stringify(omitSecrets(result.backup))}`);
						return send(200, { ...result, backup: hideSecrets(result.backup) });
					}

					return send(405, { error: `${req.method} ${reqUrl.pathname} no existe.` });
				} catch (e) {
					// Incluye el error de confirmacion faltante: el texto ya explica que hacer.
					return send(400, { error: e.message });
				}
			}

			// --- Endpoint propio: lista las destinations disponibles ------------
			if (req.url === "/__destinations") {
				const all = await destClient.list();
				return send(200, { count: all.length, destinations: all });
			}

			// --- Endpoint propio: estado del proxy ------------------------------
			if (req.url === "/__health") {
				return send(200, {
					ok: true,
					// Org/space/usuario del target de CF. La pagina lo muestra antes
					// de cualquier escritura: es el subaccount que se va a tocar.
					target: cfTarget,
					onPremise: Boolean(connectivity),
					connectivity: connectivity
						? `disponible via ${connectivity.proxyHost}:${connectivity.proxyPort}`
						: `no disponible (solo destinations de Internet). ${connectivityNote}`,
					// Estado del login: la pagina lo usa para clasificar las PP.
					login: auth.status(),
					uso: "http://localhost:<puerto>/<NOMBRE_DESTINATION>/<path>"
				});
			}

			// --- Ruteo: el primer segmento del path es la destination -----------
			const match = req.url.match(/^\/([^/?#]+)(.*)$/);
			if (!match) {
				return send(400, {
					error: "Falta el nombre de la destination en la URL.",
					uso: "http://localhost:<puerto>/<NOMBRE_DESTINATION>/<path>",
					ayuda: "GET /__destinations lista las disponibles."
				});
			}

			const destName = decodeURIComponent(match[1]);
			const restPath = match[2] || "/";

			// --- Resolver la destination (cacheado) -----------------------------
			let resolved;
			try {
				resolved = await destClient.resolve(destName, userToken);
			} catch (e) {
				return send(404, { error: e.message, ayuda: "GET /__destinations lista las disponibles." });
			}

			// --- Aplicar autenticacion ------------------------------------------
			const headers = { ...req.headers };
			delete headers.host;         // lo pone el destino
			delete headers.connection;
			delete headers["content-length"]; // se recalcula solo

			const authResult = applyAuth(headers, resolved, { userToken, loginHint });
			if (!authResult.ok) {
				return send(authResult.status || 501, { error: authResult.error, destination: destName });
			}

			// --- Elegir ruta (directo vs connectivity proxy) --------------------
			const connToken = connectivity ? await connTokenProvider() : null;
			const target = buildTarget(resolved, connectivity, connToken, connectivityNote);
			if (!target.ok) {
				return send(501, { error: target.error, destination: destName });
			}

			Object.assign(headers, target.extraHeaders || {});
			headers.host = new URL(resolved.config.URL).host;

			// El mandante del S/4 viene en la destination. Sin este header el ICM
			// usa el cliente por default, donde el usuario puede no existir.
			if (resolved.config["sap-client"] && !headers["sap-client"]) {
				headers["sap-client"] = resolved.config["sap-client"];
			}

			// Para on-premise el path debe ser una URL absoluta (proxy HTTP clasico).
			const path = target.onPremise
				? target.absoluteHost + target.basePath + restPath
				: target.basePath + restPath;

			// --- Reenviar --------------------------------------------------------
			const client = target.protocol === "https:" ? https : http;
			// Sin keep-alive: el Connectivity Proxy exige que Proxy-Authorization
			// sea consistente por conexion, y Node reusa sockets por default.
			const upstream = client.request(
				{ hostname: target.hostname, port: target.port, path, method: req.method, headers, timeout: 120000, agent: false },
				(up) => {
					log(`${up.statusCode}  ${req.method} /${destName}${restPath}`);
					res.writeHead(up.statusCode, up.headers);
					up.pipe(res);
				}
			);

			upstream.on("error", (e) => {
				const why = describeError(e);
				log(`ERR  ${req.method} /${destName}${restPath} -> ${why}`);
				if (!res.headersSent) send(502, { error: `No se pudo alcanzar el backend: ${why}`, destination: destName });
			});

			upstream.on("timeout", () => {
				upstream.destroy();
				if (!res.headersSent) send(504, { error: "Timeout contra el backend", destination: destName });
			});

			req.pipe(upstream);
		} catch (e) {
			if (!res.headersSent) send(500, { error: e.message });
		}
	});
}

module.exports = { createProxyServer, applyAuth, buildTarget, probeTcp, describeError, USER_AUTH_TYPES };
