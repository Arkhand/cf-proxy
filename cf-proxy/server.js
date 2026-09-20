#!/usr/bin/env node
/**
 * cf-proxy - Proxy local hacia las destinations de un subaccount de BTP,
 * usando los servicios de Cloud Foundry.
 *
 * A diferencia de bas-proxy (que reusa la cookie de un dev space de BAS), esta
 * solucion no depende de BAS ni de cookies que caducan: se autentica con las
 * credenciales de las instancias de `destination` y `connectivity` del space,
 * y para PrincipalPropagation con un login de usuario contra un XSUAA propio.
 *
 * No hay nada hardcodeado: org, space, instancias, apps y destinations se
 * descubren en runtime, para que la herramienta sirva en cualquier subaccount.
 * La unica convencion son los nombres de lo que despliega mta.yaml (cf-dest-*):
 * si existen, se usan directo.
 *
 * Los 6 pasos, en orden:
 *   [1] Verificar que hay sesion de CF.
 *   [2] Descubrir las instancias de servicio del space.
 *   [3] Obtener credenciales (instancias propias primero; si no, reusar keys).
 *   [4] Login de usuario contra XSUAA (solo hace falta para PrincipalPropagation).
 *   [5] Verificar acceso al Connectivity Proxy (solo hace falta para on-premise).
 *   [6] Levantar el proxy local.
 *
 * Uso:
 *   node server.js                         arranca el proxy
 *   node server.js --list                  solo lista las destinations y sale
 *   node server.js --login                 arranca y abre el login de usuario en el browser
 *   node server.js --create-keys           permite crear service keys si hace falta
 *   node server.js --port 3100             puerto local (default 3100)
 *   node server.js --xsuaa <instancia>     usar otra instancia de xsuaa para el login
 *   node server.js --tunnel                forzar el tunel `cf ssh` al Connectivity Proxy
 *                                          (automatico si existe cf-dest-app)
 *   node server.js --tunnel-app <app>      app a usar para el tunel (default: cf-dest-app o una con SSH)
 *   node server.js --tunnel-port <n>       puerto local del tunel (default 20003)
 *   node server.js --connectivity-proxy host:port
 *                                          usar un Connectivity Proxy ya alcanzable
 *   node server.js --no-open               no abrir la pagina de diagnostico en el browser
 */
const { exec } = require("child_process");
const cf = require("./lib/cf");
const { discover, OWN } = require("./lib/discover");
const { makeDestinationClient, makeTokenProvider } = require("./lib/destinations");
const { makeAuth } = require("./lib/auth");
const { createProxyServer, probeTcp } = require("./lib/proxy");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
	const i = args.indexOf(flag);
	return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(value("--port", process.env.PORT || 3100));
const ALLOW_CREATE = has("--create-keys");
const LIST_ONLY = has("--list");
const LOGIN = has("--login");
const XSUAA_INSTANCE = value("--xsuaa", null);
const FORCE_TUNNEL = has("--tunnel");
const TUNNEL_APP = value("--tunnel-app", null);
const TUNNEL_PORT = Number(value("--tunnel-port", 20003));
const MANUAL_CONN_PROXY = value("--connectivity-proxy", null);
const OPEN_BROWSER = !has("--no-open");

const log = (m) => console.log(m);

/** Abre una URL en el browser por default del sistema. Si falla, no importa: la URL esta en consola. */
function openBrowser(url) {
	const cmd =
		process.platform === "win32" ? `start "" "${url}"` :
		process.platform === "darwin" ? `open "${url}"` :
		`xdg-open "${url}"`;
	exec(cmd, () => {});
}

/** Corta la ejecucion con un mensaje de error legible. */
function fail(title, hint) {
	console.error(`\n  ERROR: ${title}`);
	if (hint) console.error(`  ${hint}`);
	console.error("");
	process.exit(1);
}

// Proceso del tunel SSH, si se abrio. Se cierra al salir para no dejar
// un `cf ssh` huerfano colgado del puerto.
let tunnelProcess = null;

function closeTunnel() {
	if (tunnelProcess && !tunnelProcess.killed) {
		tunnelProcess.kill();
		tunnelProcess = null;
	}
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		closeTunnel();
		process.exit(0);
	});
}
process.on("exit", closeTunnel);

/**
 * PASO 5b - Elegir la app por la que abrir el tunel SSH.
 *
 * Orden: la indicada con --tunnel-app; si no, la propia del MTA (cf-dest-app);
 * si no, cualquier app STARTED con SSH habilitado.
 */
async function pickTunnelApp() {
	if (TUNNEL_APP) {
		return TUNNEL_APP;
	}

	const apps = await cf.listStartedApps();

	if (apps.includes(OWN.sshApp)) {
		return OWN.sshApp;
	}

	log("  Sin app propia; buscando una app STARTED con SSH habilitado...");
	for (const candidate of apps) {
		if (await cf.isSshEnabled(candidate)) {
			return candidate;
		}
	}
	return null;
}

/**
 * PASO 5b - Abrir el tunel SSH hacia el Connectivity Proxy.
 *
 * Levanta `cf ssh -L` a traves de la app elegida y espera a que el puerto
 * local responda.
 */
async function openTunnel(remoteHost, remotePort) {
	const appName = await pickTunnelApp();

	if (!appName) {
		return {
			ok: false,
			reason:
				"Ninguna app STARTED del space tiene SSH habilitado.\n" +
				"     Opciones: npm run deploy (despliega cf-dest-app), o habilitarlo en una:\n" +
				"     cf enable-ssh <app> && cf restart <app>, o indicar una con --tunnel-app <app>."
		};
	}

	log(`  Abriendo tunel via ${appName}: localhost:${TUNNEL_PORT} -> ${remoteHost}:${remotePort}`);
	tunnelProcess = cf.startTunnel({ appName, localPort: TUNNEL_PORT, remoteHost, remotePort });

	// Se junta la salida por si el tunel falla, para mostrar el motivo real.
	let output = "";
	tunnelProcess.stdout.on("data", (d) => (output += d));
	tunnelProcess.stderr.on("data", (d) => (output += d));

	// Esperar hasta 30s a que el puerto local acepte conexiones.
	for (let i = 0; i < 30; i++) {
		if (tunnelProcess.exitCode !== null) {
			return { ok: false, reason: `\`cf ssh\` termino solo: ${output.trim().slice(0, 300) || "sin detalle"}` };
		}

		const probe = await probeTcp("127.0.0.1", TUNNEL_PORT, 1000);
		if (probe.ok) {
			return { ok: true, appName };
		}

		await new Promise((r) => setTimeout(r, 1000));
	}

	closeTunnel();
	return { ok: false, reason: `El tunel no respondio en 30s. ${output.trim().slice(0, 300)}` };
}

/**
 * PASO 5 - Decidir como se llega al Connectivity Proxy.
 *
 * Devuelve { connectivity: {proxyHost, proxyPort} | null, note }.
 * `note` explica por que no hay, para mostrarlo en /__health y en los 501.
 */
async function resolveConnectivity(creds) {
	if (!creds) {
		return {
			connectivity: null,
			note: "No hay instancia de `connectivity` en el space."
		};
	}

	const realHost = creds.onpremise_proxy_host;
	const realPort = Number(creds.onpremise_proxy_http_port || creds.onpremise_proxy_port);

	// --- Opcion 1: el usuario ya tiene un proxy alcanzable (tunel propio, etc.)
	if (MANUAL_CONN_PROXY) {
		const [host, port] = MANUAL_CONN_PROXY.split(":");
		const probe = await probeTcp(host, port);

		if (!probe.ok) {
			fail(`--connectivity-proxy ${MANUAL_CONN_PROXY} no responde (${probe.why}).`);
		}

		log(`  OK  Connectivity Proxy via ${host}:${port} (indicado a mano)`);
		return { connectivity: { proxyHost: host, proxyPort: Number(port) }, note: "" };
	}

	// --- Opcion 2: probar el host real (funciona si se corre dentro de CF/BAS)
	const direct = await probeTcp(realHost, realPort);

	if (direct.ok) {
		log(`  OK  Connectivity Proxy alcanzable directo: ${realHost}:${realPort}`);
		return { connectivity: { proxyHost: realHost, proxyPort: realPort }, note: "" };
	}

	log(`  --  ${realHost}:${realPort} no es alcanzable desde esta red (${direct.why}).`);
	log("      Es lo esperado desde una PC: el Connectivity Proxy es interno a CF.");

	// --- Opcion 3: tunel SSH. Automatico si esta la app propia; si no, con --tunnel.
	const ownAppStarted = !FORCE_TUNNEL && !TUNNEL_APP && (await cf.listStartedApps()).includes(OWN.sshApp);

	if (FORCE_TUNNEL || TUNNEL_APP || ownAppStarted) {
		const tunnel = await openTunnel(realHost, realPort);

		if (!tunnel.ok) {
			fail("No se pudo abrir el tunel SSH.", tunnel.reason);
		}

		log(`  OK  Connectivity Proxy via tunel SSH (app ${tunnel.appName}) en localhost:${TUNNEL_PORT}`);
		return { connectivity: { proxyHost: "127.0.0.1", proxyPort: TUNNEL_PORT }, note: "" };
	}

	// --- Sin acceso: se sigue solo con destinations de Internet ---------------
	log("      Correr con --tunnel (o npm run deploy) para abrirlo via `cf ssh`. Se sigue solo con destinations de Internet.");
	return {
		connectivity: null,
		note:
			`El Connectivity Proxy (${realHost}:${realPort}) no es alcanzable desde esta red. ` +
			"Correr cf-proxy con --tunnel, o desplegar mta.yaml para que el tunel sea automatico."
	};
}

async function main() {
	console.log("\n  cf-proxy - proxy local via servicios de Cloud Foundry\n");

	// ========================================================================
	// PASO 1 - Sesion de CF
	// ========================================================================
	log("[1/6] Verificando sesion de Cloud Foundry...");
	const session = await cf.checkLogin();

	if (!session.ok) {
		fail(session.reason === "no-cli" ? "El CLI `cf` no esta disponible." : "No hay sesion de CF activa.", session.hint);
	}

	log(`  OK  ${session.user}`);
	log(`      org: ${session.org} / space: ${session.space}`);
	log(`      api: ${session.api}`);

	// ========================================================================
	// PASO 2 y 3 - Descubrir servicios y obtener credenciales
	// ========================================================================
	const found = await discover({ allowCreate: ALLOW_CREATE, preferredXsuaa: XSUAA_INSTANCE, log });

	if (!found.ok) {
		fail(found.error, "Revisar que el space tenga una instancia del servicio `destination`, o correr npm run deploy.");
	}

	const destClient = makeDestinationClient(found.destination.creds);
	const connCreds = found.connectivity ? found.connectivity.creds : null;
	const connTokenProvider = connCreds ? makeTokenProvider(connCreds) : null;

	// ========================================================================
	// PASO 4 - Login de usuario (solo importa para PrincipalPropagation)
	// ========================================================================
	log("\n[4/6] Login de usuario (para PrincipalPropagation)...");
	const auth = makeAuth({
		creds: found.xsuaa ? found.xsuaa.creds : null,
		callbackUrl: `http://localhost:${PORT}/__callback`
	});

	if (!auth.configured) {
		log(`  --  no disponible: ${found.xsuaaReason.split("\n")[0]}`);
	} else if (await auth.getUserToken()) {
		const st = auth.status();
		log(`  OK  sesion de ${st.user.name}${st.user.email ? ` <${st.user.email}>` : ""} (vence ${st.expiresAt}; se renueva sola)`);
	} else {
		log(`  --  sin sesion. Abrir http://localhost:${PORT}/__login (o arrancar con --login).`);
	}

	// ========================================================================
	// Modo --list: mostrar destinations y salir
	// ========================================================================
	if (LIST_ONLY) {
		log("\n  Destinations del subaccount:\n");
		const all = await destClient.list();

		// Se agrupan por tipo de auth para que se vea de un vistazo cuales
		// van a funcionar desde la PC y cuales no.
		const isUsableAuth = (d) =>
			d.auth === "BasicAuthentication" || d.auth === "NoAuthentication" || String(d.auth).startsWith("OAuth2");
		const usable = all.filter(isUsableAuth);
		const pp = all.filter((d) => d.auth === "PrincipalPropagation");

		for (const d of usable) {
			const op = d.proxyType === "OnPremise" ? " [on-prem: requiere tunel]" : "";
			log(`   +  ${d.name}${op}`);
			log(`         ${d.auth} -> ${d.url || "?"}`);
		}
		for (const d of pp) {
			const how = auth.configured
				? (auth.status().loggedIn ? "login OK, requiere tunel" : "requiere login + tunel")
				: "requiere XSUAA propio: npm run deploy";
			log(`   ~  ${d.name}  (PrincipalPropagation: ${how})`);
		}

		log(`\n  Total: ${all.length}  |  directas: ${usable.length}  |  principal propagation: ${pp.length}\n`);
		return;
	}

	// ========================================================================
	// PASO 5 - Acceso al Connectivity Proxy (solo importa para on-premise)
	// ========================================================================
	log("\n[5/6] Verificando acceso al Connectivity Proxy...");
	const { connectivity, note: connectivityNote } = await resolveConnectivity(connCreds);

	// ========================================================================
	// PASO 6 - Levantar el proxy
	// ========================================================================
	log("\n[6/6] Levantando proxy local...");

	const server = createProxyServer({
		destClient, connectivity, connTokenProvider, connectivityNote, auth, log,
		// Se muestra en la pagina antes de crear/editar: es el subaccount que se toca.
		cfTarget: { org: session.org, space: session.space, user: session.user }
	});

	server.listen(PORT, () => {
		console.log(`\n  Escuchando en http://localhost:${PORT}`);
		console.log(`  Pagina:   http://localhost:${PORT}/`);
		console.log(`  Uso:      http://localhost:${PORT}/<NOMBRE_DESTINATION>/<path>`);
		console.log(`  Listado:  http://localhost:${PORT}/__destinations`);
		console.log(`  Detalle:  http://localhost:${PORT}/__destination/<NOMBRE>`);
		console.log(`  Estado:   http://localhost:${PORT}/__health`);
		console.log(`  Editar:   desde la pagina (botones Nueva destination / Editar; piden confirmacion)`);
		console.log(`  Login:    ${auth.configured ? `http://localhost:${PORT}/__login` : "no disponible (npm run deploy)"}`);
		console.log(`  On-prem:  ${connectivity ? "si" : "no (ver /__health)"}\n`);

		if (LOGIN && auth.configured) {
			openBrowser(`http://localhost:${PORT}/__login`);
		} else if (OPEN_BROWSER) {
			openBrowser(`http://localhost:${PORT}/`);
		}
	});

	server.on("error", (e) => {
		fail(`No se pudo abrir el puerto ${PORT}: ${e.message}`, "Probar con --port <otro>.");
	});
}

main().catch((e) => fail(e.message));
