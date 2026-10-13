/**
 * PASO 5b - Tunel `cf ssh -L` a traves de una app del space.
 *
 * Lo usan dos cosas: el proxy (para llegar al Connectivity Proxy) y los
 * tuneles a servicios (tunnel.js, p.ej. PostgreSQL). En los dos casos el
 * destino solo es alcanzable desde adentro de CF, y cualquier app corriendo
 * del space sirve de salto de red.
 */
const cf = require("./cf");
const { OWN } = require("./discover");
const { probeTcp } = require("./proxy");

/**
 * Elegir la app por la que abrir el tunel.
 *
 * Orden: la indicada (`preferred`); si no, la propia del MTA (cf-dest-app);
 * si no, cualquier app STARTED con SSH habilitado. null si no hay ninguna.
 */
async function pickApp(preferred, log = () => {}) {
	if (preferred) {
		return preferred;
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

/** Texto de ayuda cuando no hay app para el tunel. */
const NO_APP_HINT =
	"Ninguna app STARTED del space tiene SSH habilitado.\n" +
	"     Opciones: cf-proxy cf <perfil> -- deploy <mtar> (despliega cf-dest-app), o habilitarlo en una:\n" +
	"     cf enable-ssh <app> && cf restart <app>, o indicar una app a mano.";

/**
 * Abrir el tunel y esperar hasta 30s a que el puerto local acepte conexiones.
 *
 * `onSpawn(child)` se llama apenas existe el proceso, para que quien lo abre
 * lo registre y lo pueda cortar aunque el arranque no termine.
 * Devuelve {ok:true, child} o {ok:false, reason}; si falla, el proceso ya esta cortado.
 */
async function open({ appName, localPort, remoteHost, remotePort, onSpawn = () => {} }) {
	const child = cf.startTunnel({ appName, localPort, remoteHost, remotePort });
	onSpawn(child);

	// Se junta la salida por si el tunel falla, para mostrar el motivo real.
	let output = "";
	child.stdout.on("data", (d) => (output += d));
	child.stderr.on("data", (d) => (output += d));

	for (let i = 0; i < 30; i++) {
		if (child.exitCode !== null) {
			return { ok: false, reason: `\`cf ssh\` termino solo: ${output.trim().slice(0, 300) || "sin detalle"}` };
		}

		const probe = await probeTcp("127.0.0.1", localPort, 1000);
		if (probe.ok) {
			return { ok: true, child };
		}

		await new Promise((r) => setTimeout(r, 1000));
	}

	child.kill();
	return { ok: false, reason: `El tunel no respondio en 30s. ${output.trim().slice(0, 300)}` };
}

module.exports = { pickApp, open, NO_APP_HINT };
