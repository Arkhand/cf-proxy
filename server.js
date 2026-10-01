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
 * Siempre arranca desde un PERFIL guardado (lib/profiles.js): una subcuenta
 * de cliente, con su puerto y su propio CF_HOME. Nunca usa la sesion global
 * de `cf`, asi que no cambia el target de la terminal ni el de otro proxy.
 * Lo normal es arrancarlo con la consola (bin/cf-proxy.js start <perfil>),
 * que lo deja corriendo en segundo plano y lo registra.
 *
 * Los pasos, en orden:
 *   [0] Cargar el perfil, tomar el lock de la corrida y verificar el puerto.
 *   [1] Verificar que hay sesion de CF en el perfil y apuntar a su org/space.
 *   [2] Descubrir las instancias de servicio del space.
 *   [3] Obtener credenciales (instancias propias primero; si no, reusar keys).
 *   [4] Login de usuario contra XSUAA (solo hace falta para PrincipalPropagation).
 *   [5] Verificar acceso al Connectivity Proxy (solo hace falta para on-premise).
 *   [6] Levantar el proxy local.
 *
 * Uso (puerto y flags salen del perfil; estos los suman, no los quitan):
 *   node server.js --profile <p>           arranca el proxy del perfil, en primer plano
 *   node server.js --profile <p> --list    solo lista las destinations y sale
 *   --login                                abre el login de usuario en el browser
 *   --create-keys                          permite crear service keys si hace falta
 *   --xsuaa <instancia>                    usar otra instancia de xsuaa para el login
 *   --tunnel                               forzar el tunel `cf ssh` al Connectivity Proxy
 *                                          (automatico si existe cf-dest-app)
 *   --tunnel-app <app>                     app a usar para el tunel (default: cf-dest-app o una con SSH)
 *   --tunnel-port <n>                      puerto local del tunel (default: uno libre)
 *   --connectivity-proxy host:port         usar un Connectivity Proxy ya alcanzable
 *   --no-open                              no abrir la pagina de diagnostico en el browser
 *   --origin cli|ui                        quien lo lanzo (lo pone la consola; se ve en `ps`)
 *   --log <archivo>                        donde escribe la salida (lo pone la consola)
 */
const { exec } = require("child_process");
const net = require("net");
const cf = require("./lib/cf");
const profiles = require("./lib/profiles");
const runs = require("./lib/runs");
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

const log = (m) => console.log(m);

/** Corta la ejecucion con un mensaje de error legible. `code`: ver runs.EXIT. */
function fail(title, hint, code = runs.EXIT.ERROR) {
	console.error(`\n  ERROR: ${title}`);
	if (hint) console.error(`  ${hint}`);
	console.error("");
	process.exit(code);
}

// ============================================================================
// PASO 0a - El perfil manda: puerto, flags, org/space y CF_HOME salen de ahi
// ============================================================================
const PROFILE_NAME = value("--profile", null);
const CLI_HINT = "node bin/cf-proxy.js";

if (!PROFILE_NAME) {
	const names = profiles.load().map((p) => p.name);
	fail(
		"Falta --profile. cf-proxy solo arranca desde un perfil guardado.",
		(names.length ? `Perfiles: ${names.join(", ")}. ` : "No hay perfiles: crear uno con `" + CLI_HINT + " profiles add`. ") +
			`Arrancar con: ${CLI_HINT} start <perfil>`,
		runs.EXIT.USAGE
	);
}

const PROFILE = profiles.get(PROFILE_NAME);
if (!PROFILE) {
	fail(`No existe el perfil ${PROFILE_NAME}.`, `Ver: ${CLI_HINT} profiles list`, runs.EXIT.USAGE);
}
if (PROFILE.problems.length) {
	fail(`El perfil ${PROFILE_NAME} no puede arrancar: ${PROFILE.problems.join("; ")}.`,
		`Corregirlo con: ${CLI_HINT} profiles edit ${PROFILE_NAME} ...`, runs.EXIT.USAGE);
}

// Desde aca, todo `cf` corre en una copia privada de la sesion del perfil: el
// target que ponga este proxy no le llega a nadie mas (ni a otro proxy ni a un
// deploy de cf-target). Al salir vuelven solo los tokens renovados.
const sessions = require("./lib/sessions");
const sessionRun = sessions.openRun(profiles.sessionHomeOf(PROFILE));
cf.configure({ cfHome: sessionRun.home });

const PORT = PROFILE.port;
const ALLOW_CREATE = has("--create-keys") || PROFILE.flags.create_keys;
const LIST_ONLY = has("--list");
const LOGIN = has("--login") || PROFILE.flags.login;
const XSUAA_INSTANCE = value("--xsuaa", null);
const FORCE_TUNNEL = has("--tunnel") || PROFILE.flags.tunnel;
const TUNNEL_APP = value("--tunnel-app", null);
const FIXED_TUNNEL_PORT = value("--tunnel-port", null);
const MANUAL_CONN_PROXY = value("--connectivity-proxy", null);
const OPEN_BROWSER = !has("--no-open") && PROFILE.flags.open_browser;
const ORIGIN = value("--origin", "foreground");
const LOG_FILE = value("--log", null);

// Registro de la corrida (lock). Lo completa el PASO 0b; --list no lo toma.
let run = null;

/** Abre una URL en el browser por default del sistema. Si falla, no importa: la URL esta en consola. */
function openBrowser(url) {
	const cmd =
		process.platform === "win32" ? `start "" "${url}"` :
		process.platform === "darwin" ? `open "${url}"` :
		`xdg-open "${url}"`;
	exec(cmd, () => {});
}

// Proceso del tunel SSH, si se abrio. Se cierra al salir para no dejar
// un `cf ssh` huerfano colgado del puerto.
let tunnelProcess = null;

function closeTunnel() {
	if (tunnelProcess && !tunnelProcess.killed) {
		tunnelProcess.kill();
		tunnelProcess = null;
		if (run) run.update({ tunnelPid: null });
	}
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		closeTunnel();
		process.exit(0);
	});
}
process.on("exit", () => {
	closeTunnel();
	// Soltar el lock: el perfil queda libre para otro arranque.
	if (run) run.release();
	// Despues del tunel: el `cf ssh` usaba esta copia.
	try {
		sessions.writeBack(sessionRun);
	} finally {
		sessions.closeRun(sessionRun);
	}
});

/** Un puerto local libre, elegido por el sistema. Para el tunel: dos proxies no pueden compartirlo. */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/** true si el puerto del proxy esta libre. Se prueba igual que lo va a abrir server.listen. */
function portFree(port) {
	return new Promise((resolve) => {
		const srv = net.createServer();
		srv.once("error", () => resolve(false));
		srv.listen(port, () => srv.close(() => resolve(true)));
	});
}

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
				"     Opciones: cf-proxy cf <perfil> -- deploy <mtar> (despliega cf-dest-app), o habilitarlo en una:\n" +
				"     cf enable-ssh <app> && cf restart <app>, o indicar una con --tunnel-app <app>."
		};
	}

	const localPort = FIXED_TUNNEL_PORT ? Number(FIXED_TUNNEL_PORT) : await freePort();
	log(`  Abriendo tunel via ${appName}: localhost:${localPort} -> ${remoteHost}:${remotePort}`);
	tunnelProcess = cf.startTunnel({ appName, localPort, remoteHost, remotePort });
	if (run) run.update({ tunnelPid: tunnelProcess.pid });

	// Se junta la salida por si el tunel falla, para mostrar el motivo real.
	let output = "";
	tunnelProcess.stdout.on("data", (d) => (output += d));
	tunnelProcess.stderr.on("data", (d) => (output += d));

	// Esperar hasta 30s a que el puerto local acepte conexiones.
	for (let i = 0; i < 30; i++) {
		if (tunnelProcess.exitCode !== null) {
			return { ok: false, reason: `\`cf ssh\` termino solo: ${output.trim().slice(0, 300) || "sin detalle"}` };
		}

		const probe = await probeTcp("127.0.0.1", localPort, 1000);
		if (probe.ok) {
			return { ok: true, appName, localPort };
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

		log(`  OK  Connectivity Proxy via tunel SSH (app ${tunnel.appName}) en localhost:${tunnel.localPort}`);
		return { connectivity: { proxyHost: "127.0.0.1", proxyPort: tunnel.localPort }, note: "" };
	}

	// --- Sin acceso: se sigue solo con destinations de Internet ---------------
	log("      Correr con --tunnel (o cf-proxy cf <perfil> -- deploy <mtar>) para abrirlo via `cf ssh`. Se sigue solo con destinations de Internet.");
	return {
		connectivity: null,
		note:
			`El Connectivity Proxy (${realHost}:${realPort}) no es alcanzable desde esta red. ` +
			"Correr cf-proxy con --tunnel, o desplegar mta.yaml para que el tunel sea automatico."
	};
}

async function main() {
	console.log("\n  cf-proxy - proxy local via servicios de Cloud Foundry\n");
	log(`  Perfil: ${PROFILE.title} (${PROFILE.name})  ->  ${PROFILE.org} / ${PROFILE.space}  puerto ${PORT}\n`);

	// ========================================================================
	// PASO 0b - Lock de la corrida y puerto libre
	// ========================================================================
	// Antes de cualquier otra cosa: si el perfil ya corre, no se abre un
	// segundo tunel ni se pisa el puerto. --list no corre nada, no lo necesita.
	if (!LIST_ONLY) {
		const lock = runs.acquire(PROFILE.name, {
			title: PROFILE.title,
			port: PORT,
			url: `http://localhost:${PORT}/`,
			api: PROFILE.api,
			org: PROFILE.org,
			space: PROFILE.space,
			user: PROFILE.user,
			origin: ORIGIN,
			log: LOG_FILE
		});
		if (lock.busy) {
			const r = lock.record;
			fail(`El perfil ${PROFILE.name} ya esta corriendo${r ? ` (pid ${r.pid}) en ${r.url}` : ""}.`,
				`Ver: ${CLI_HINT} ps   Detener: ${CLI_HINT} stop ${PROFILE.name}`, runs.EXIT.BUSY);
		}
		run = lock;

		// Se chequea ANTES del tunel: un EADDRINUSE despues dejaria un `cf ssh` colgado.
		if (!(await portFree(PORT))) {
			fail(`El puerto ${PORT} esta ocupado por otro programa.`,
				`Liberarlo, o cambiar el puerto del perfil: ${CLI_HINT} profiles edit ${PROFILE.name} --port auto`,
				runs.EXIT.PORT_BUSY);
		}
	}

	// ========================================================================
	// PASO 1 - Sesion de CF (la del perfil) y target fijo
	// ========================================================================
	log("[1/6] Verificando sesion de Cloud Foundry del perfil...");
	const session = await cf.checkLogin();

	if (!session.ok) {
		if (session.reason === "no-cli") {
			fail("El CLI `cf` no esta disponible.", session.hint);
		}
		fail(`El perfil ${PROFILE.name} no tiene sesion de CF (o vencio).`,
			`Loguearse con: ${CLI_HINT} login ${PROFILE.name}`, runs.EXIT.NO_SESSION);
	}

	if (profiles.normalizeApi(session.api) !== profiles.normalizeApi(PROFILE.api)) {
		fail(`La sesion del perfil es de ${session.api}, pero el perfil dice ${PROFILE.api}.`,
			`Volver a loguearse con: ${CLI_HINT} login ${PROFILE.name}`, runs.EXIT.NO_SESSION);
	}
	if (PROFILE.user && String(session.user).toLowerCase() !== PROFILE.user.toLowerCase()) {
		fail(`La sesion es de ${session.user}, pero el perfil es de ${PROFILE.user}.`,
			`Volver a loguearse con: ${CLI_HINT} login ${PROFILE.name}`, runs.EXIT.MISMATCH);
	}

	// Siempre se apunta al org/space del perfil. Es seguro: el CF_HOME es solo
	// de este perfil, y deja el arranque deterministico aunque alguien haya
	// cambiado de space desde la pagina en la corrida anterior.
	const targeted = await cf.setTarget(PROFILE.org, PROFILE.space);
	if (!targeted.ok) {
		fail(`No se pudo apuntar a ${PROFILE.org} / ${PROFILE.space}: ${targeted.error}`,
			"Revisar el org/space del perfil, o el acceso del usuario a esa subcuenta.");
	}
	session.org = PROFILE.org;
	session.space = PROFILE.space;
	if (run) run.update({ user: session.user });

	log(`  OK  ${session.user}`);
	log(`      org: ${session.org} / space: ${session.space}`);
	log(`      api: ${session.api}`);

	// ========================================================================
	// PASO 2 y 3 - Descubrir servicios y obtener credenciales
	// ========================================================================
	const found = await discover({ allowCreate: ALLOW_CREATE, preferredXsuaa: XSUAA_INSTANCE, log });

	if (!found.ok) {
		fail(found.error,
			`Revisar que el space tenga una instancia del servicio \`destination\`, o desplegar los recursos: ${CLI_HINT} cf ${PROFILE.name} -- deploy mta_archives/cf-dest_1.0.0.mtar -f`,
			runs.EXIT.NO_RESOURCES);
	}

	// Contexto MUTABLE: todo lo que depende del subaccount. El proxy lo lee en
	// cada request, asi que cambiar de org/space (retarget) es reemplazar estos
	// campos, sin reiniciar el proceso ni cortar el puerto.
	const ctx = {
		destClient: makeDestinationClient(found.destination.creds),
		connectivity: null,          // lo completa el PASO 5
		connTokenProvider: null,
		connectivityNote: "",
		cfTarget: { org: session.org, space: session.space, user: session.user },
		// Un perfil es una subcuenta: desde la pagina se cambia de space, no de org.
		lockedOrg: PROFILE.org
	};

	const connCreds = found.connectivity ? found.connectivity.creds : null;
	ctx.connTokenProvider = connCreds ? makeTokenProvider(connCreds) : null;

	// ========================================================================
	// PASO 4 - Login de usuario (solo importa para PrincipalPropagation)
	// ========================================================================
	log("\n[4/6] Login de usuario (para PrincipalPropagation)...");
	const auth = makeAuth({
		creds: found.xsuaa ? found.xsuaa.creds : null,
		callbackUrl: `http://localhost:${PORT}/__callback`
	});

	const portWarning = auth.configured ? profiles.checkXsuaaPort(PORT) : null;
	if (portWarning) {
		log(`  !!  ${portWarning}`);
	}

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
		const all = await ctx.destClient.list();

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
				: "requiere XSUAA propio: cf-proxy cf <perfil> -- deploy <mtar>";
			log(`   ~  ${d.name}  (PrincipalPropagation: ${how})`);
		}

		log(`\n  Total: ${all.length}  |  directas: ${usable.length}  |  principal propagation: ${pp.length}\n`);
		return;
	}

	// ========================================================================
	// PASO 5 - Acceso al Connectivity Proxy (solo importa para on-premise)
	// ========================================================================
	log("\n[5/6] Verificando acceso al Connectivity Proxy...");
	const paso5 = await resolveConnectivity(connCreds);
	ctx.connectivity = paso5.connectivity;
	ctx.connectivityNote = paso5.note;

	/**
	 * Cambiar de space sin reiniciar (el org es el del perfil, fijo).
	 *
	 * Reapunta el CLI del perfil y rehace los pasos 2, 3 y 5: las
	 * credenciales del space anterior pueden no servir. Si algo falla, se
	 * restaura el target anterior y el contexto queda intacto.
	 *
	 * El tunel SSH se cierra siempre: cuelga de una app del space viejo.
	 */
	async function retarget(org, space) {
		if (org !== PROFILE.org) {
			return { ok: false, error: `Este proxy es del org ${PROFILE.org}; ${org} necesita su propio perfil.` };
		}
		const previous = { ...ctx.cfTarget };
		log(`\n  Cambiando target a ${org} / ${space}...`);

		const applied = await cf.setTarget(org, space);
		if (!applied.ok) {
			return applied;
		}

		closeTunnel();

		const next = await discover({ allowCreate: ALLOW_CREATE, preferredXsuaa: XSUAA_INSTANCE, log });
		if (!next.ok) {
			// Volver atras: dejar el CLI donde estaba es mas util que dejarlo a medias.
			await cf.setTarget(previous.org, previous.space);
			return { ok: false, error: `${org}/${space}: ${next.error.split("\n")[0]}` };
		}

		const nextConn = next.connectivity ? next.connectivity.creds : null;
		const conn = await resolveConnectivity(nextConn);

		ctx.destClient = makeDestinationClient(next.destination.creds);
		ctx.connTokenProvider = nextConn ? makeTokenProvider(nextConn) : null;
		ctx.connectivity = conn.connectivity;
		ctx.connectivityNote = conn.note;
		ctx.cfTarget = { org, space, user: previous.user };
		if (run) run.update({ space });

		log(`  OK  target: ${org} / ${space}\n`);
		return { ok: true };
	}

	// ========================================================================
	// PASO 6 - Levantar el proxy
	// ========================================================================
	log("\n[6/6] Levantando proxy local...");

	const server = createProxyServer({
		ctx,
		auth,
		onRetarget: retarget,
		listTargets: () => cf.listSpaces(PROFILE.org),
		identity: { profile: PROFILE.name, title: PROFILE.title, pid: process.pid, port: PORT },
		log
	});

	server.listen(PORT, () => {
		// Recien ahora la corrida esta lista: `start` de la consola espera esto.
		if (run) run.update({ state: "listening" });
		console.log(`\n  Escuchando en http://localhost:${PORT}`);
		console.log(`  Pagina:   http://localhost:${PORT}/`);
		console.log(`  Uso:      http://localhost:${PORT}/<NOMBRE_DESTINATION>/<path>`);
		console.log(`  Listado:  http://localhost:${PORT}/__destinations`);
		console.log(`  Detalle:  http://localhost:${PORT}/__destination/<NOMBRE>`);
		console.log(`  Estado:   http://localhost:${PORT}/__health`);
		console.log(`  Probar:   http://localhost:${PORT}/__test/<NOMBRE>`);
		console.log(`  Editar:   desde la pagina (botones Nueva destination / Editar; piden confirmacion)`);
		console.log(`  Login:    ${auth.configured ? `http://localhost:${PORT}/__login` : "no disponible (cf-proxy cf <perfil> -- deploy <mtar>)"}`);
		console.log(`  Target:   ${ctx.cfTarget.org} / ${ctx.cfTarget.space}  (se cambia desde la pagina)`);
		console.log(`  On-prem:  ${ctx.connectivity ? "si" : "no (ver /__health)"}\n`);

		if (LOGIN && auth.configured) {
			openBrowser(`http://localhost:${PORT}/__login`);
		} else if (OPEN_BROWSER) {
			openBrowser(`http://localhost:${PORT}/`);
		}
	});

	server.on("error", (e) => {
		fail(`No se pudo abrir el puerto ${PORT}: ${e.message}`,
			`Cambiar el puerto del perfil: ${CLI_HINT} profiles edit ${PROFILE.name} --port auto`, runs.EXIT.PORT_BUSY);
	});
}

main().catch((e) => fail(e.message));
