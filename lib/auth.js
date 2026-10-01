/**
 * PASO 4 - Login de usuario contra XSUAA (authorization_code).
 *
 * Por que existe: las destinations con PrincipalPropagation necesitan que el
 * Cloud Connector reciba un JWT del USUARIO FINAL, no de una aplicacion. Ese
 * JWT solo sale de un login real: browser -> XSUAA -> IdP -> callback.
 *
 * Como funciona:
 *
 *   1. GET /__login en el proxy redirige a XSUAA /oauth/authorize.
 *   2. El usuario se loguea en su IdP (SSO corporativo funciona: es browser).
 *   3. XSUAA vuelve a GET /__callback?code=... en el proxy.
 *   4. Se cambia el code por access_token + refresh_token en /oauth/token.
 *   5. Se guardan en ~/.cf-proxy/ (solo lectura del usuario). Con el refresh
 *      token el login se repite cada ~30 dias, no cada pocas horas.
 *
 * Requiere un XSUAA cuyas redirect-uris permitan http://localhost. Los de las
 * apps desplegadas no lo permiten; por eso mta.yaml crea uno propio.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { request } = require("./destinations");

/** Decodifica el payload de un JWT sin validar firma (solo para leer claims). */
function decodeJwt(token) {
	try {
		const payload = String(token).split(".")[1];
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch (e) {
		return {};
	}
}

/** Objeto nulo: misma interfaz, sin XSUAA configurado. El resto del codigo no tiene que preguntar. */
function noAuth(reason) {
	return {
		configured: false,
		reason,
		authorizeUrl: () => null,
		handleCallback: async () => { throw new Error(reason); },
		getUserToken: async () => null,
		status: () => ({ configured: false, loggedIn: false, reason }),
		logout: () => {}
	};
}

/**
 * Crea el manejador de login para unas credenciales de XSUAA.
 *
 * @param creds        service key de xsuaa: { clientid, clientsecret, url, identityzone }
 * @param callbackUrl  a donde tiene que volver XSUAA: http://localhost:<puerto>/__callback
 * @param cacheDir     donde guardar los tokens (default ~/.cf-proxy)
 */
function makeAuth({ creds, callbackUrl, cacheDir = path.join(os.homedir(), ".cf-proxy") } = {}) {
	if (!creds) {
		return noAuth("No hay un XSUAA propio en el space. Desplegar mta.yaml (cf-proxy cf <perfil> -- deploy <mtar>).");
	}

	const base = creds.url.replace(/\/+$/, "");
	const basicAuth = Buffer.from(`${creds.clientid}:${creds.clientsecret}`).toString("base64");

	// Un archivo por (zona, cliente): distintos subaccounts no se pisan.
	const clientHash = crypto.createHash("sha256").update(creds.clientid).digest("hex").slice(0, 8);
	const cacheFile = path.join(cacheDir, `user-token-${creds.identityzone || "zone"}-${clientHash}.json`);

	// Estados pendientes del flujo OAuth: protege el callback contra codes ajenos.
	const pendingStates = new Set();

	// --- Sesion en memoria, respaldada en disco -----------------------------
	let session = null; // { access_token, refresh_token, expiresAt, user }

	function loadSession() {
		try {
			session = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
		} catch (e) {
			session = null;
		}
	}

	function saveSession() {
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(cacheFile, JSON.stringify(session, null, 2), { mode: 0o600 });
	}

	function clearSession() {
		session = null;
		try {
			fs.unlinkSync(cacheFile);
		} catch (e) {
			// no existia
		}
	}

	loadSession();

	// --- Paso 1: URL de autorizacion -----------------------------------------
	function authorizeUrl() {
		const state = crypto.randomBytes(16).toString("hex");
		pendingStates.add(state);

		const params = new URLSearchParams({
			response_type: "code",
			client_id: creds.clientid,
			redirect_uri: callbackUrl,
			state
		});
		return `${base}/oauth/authorize?${params}`;
	}

	// --- Paso 4: intercambio en /oauth/token ---------------------------------
	async function tokenRequest(form) {
		const res = await request(`${base}/oauth/token`, {
			method: "POST",
			headers: {
				authorization: `Basic ${basicAuth}`,
				"content-type": "application/x-www-form-urlencoded"
			},
			body: new URLSearchParams(form).toString()
		});

		if (res.status !== 200) {
			throw new Error(`XSUAA respondio ${res.status}: ${res.body.slice(0, 300)}`);
		}
		return JSON.parse(res.body);
	}

	// --- Paso 5: guardar ------------------------------------------------------
	function storeTokens(parsed) {
		const claims = decodeJwt(parsed.access_token);
		session = {
			access_token: parsed.access_token,
			refresh_token: parsed.refresh_token || (session && session.refresh_token) || null,
			expiresAt: Date.now() + Number(parsed.expires_in || 3600) * 1000,
			user: {
				name: claims.user_name || claims.sub || "?",
				email: claims.email || null,
				zone: claims.zid || creds.identityzone || null
			}
		};
		saveSession();
	}

	async function handleCallback({ code, state }) {
		if (!state || !pendingStates.has(state)) {
			throw new Error("El `state` del callback no coincide con ningun login iniciado desde este proxy.");
		}
		pendingStates.delete(state);

		const parsed = await tokenRequest({
			grant_type: "authorization_code",
			code,
			redirect_uri: callbackUrl
		});
		storeTokens(parsed);
		return session.user;
	}

	/**
	 * Devuelve un access token vigente, renovandolo con el refresh token si hace
	 * falta. `null` si no hay sesion o no se pudo renovar (hay que volver a loguear).
	 */
	async function getUserToken() {
		if (!session) {
			return null;
		}

		// Margen de 60s para no mandar un token que vence en el camino.
		if (Date.now() < session.expiresAt - 60000) {
			return session.access_token;
		}

		if (!session.refresh_token) {
			clearSession();
			return null;
		}

		try {
			const parsed = await tokenRequest({
				grant_type: "refresh_token",
				refresh_token: session.refresh_token
			});
			storeTokens(parsed);
			return session.access_token;
		} catch (e) {
			// El refresh token tambien vencio (o lo revocaron): sesion nueva.
			clearSession();
			return null;
		}
	}

	function status() {
		if (!session) {
			return { configured: true, loggedIn: false, loginPath: "/__login" };
		}
		return {
			configured: true,
			loggedIn: true,
			user: session.user,
			expiresAt: new Date(session.expiresAt).toISOString(),
			canRefresh: Boolean(session.refresh_token),
			loginPath: "/__login"
		};
	}

	return {
		configured: true,
		cacheFile,
		authorizeUrl,
		handleCallback,
		getUserToken,
		status,
		logout: clearSession
	};
}

module.exports = { makeAuth, decodeJwt };
