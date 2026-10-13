/**
 * `cf` FALSO para los tests. Se activa con CF_PROXY_CF_BIN=test/fake-cf.js.
 *
 * Anota cada invocacion (argumentos y CF_HOME/CF_PLUGIN_HOME) en el archivo
 * FAKE_CF_LOG, y guarda su "sesion" en $CF_HOME/.cf/config.json, donde la guarda el
 * cf real: asi las copias por corrida de lib/sessions.js la llevan y la traen igual
 * que con el `cf` real. Responde lo justo para login, target y las consultas de
 * orgs/spaces.
 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const home = process.env.CF_HOME || "";
const sessionFile = path.join(home, ".cf", "config.json");

if (process.env.FAKE_CF_LOG) {
	fs.appendFileSync(process.env.FAKE_CF_LOG, JSON.stringify({
		args, CF_HOME: process.env.CF_HOME || null, CF_PLUGIN_HOME: process.env.CF_PLUGIN_HOME || null
	}) + "\n");
}

let s = {};
try { s = JSON.parse(fs.readFileSync(sessionFile, "utf8")); } catch (e) { /* sin sesion */ }
const save = () => { fs.mkdirSync(path.dirname(sessionFile), { recursive: true }); fs.writeFileSync(sessionFile, JSON.stringify(s)); };
const flag = (f) => (args.indexOf(f) !== -1 ? args[args.indexOf(f) + 1] : undefined);
const out = (text, code = 0) => { process.stdout.write(text + "\n"); process.exit(code); };

switch (args[0]) {
	case "--version":
	case "version":
		out("cf version 8.0.0-fake");
		break;
	case "api":
		s.api = args[1];
		save();
		out(`Setting API endpoint to ${args[1]}...\nOK`);
		break;
	case "auth":
		if (process.env.CF_PASSWORD !== "good") out("Credentials were rejected.\nFAILED", 1);
		Object.assign(s, { logged: true, user: process.env.CF_USERNAME });
		save();
		out("OK");
		break;
	case "login":
		if (flag("--sso-passcode") !== "good") out("Invalid passcode.\nFAILED", 1);
		Object.assign(s, { logged: true, api: flag("-a"), user: "sso-user" });
		save();
		out("OK");
		break;
	case "target":
		if (!s.logged) out("Not logged in. Use 'cf login' to log in.\nFAILED", 1);
		if (flag("-o") === "org-inexistente") out(`Organization '${flag("-o")}' not found.\nFAILED`, 1);
		if (flag("-o")) {
			Object.assign(s, { org: flag("-o"), space: flag("-s") });
			save();
		}
		out(`API endpoint:   ${s.api}\nuser:           ${s.user}\norg:            ${s.org || ""}\nspace:          ${s.space || ""}`);
		break;
	case "space":
		// `cf space <nombre> --guid`
		out("11111111-2222-3333-4444-555555555555");
		break;
	case "ssh": {
		// `cf ssh -k -N -L 127.0.0.1:<local>:<host>:<remoto> <app>`: un port-forward
		// de verdad (TCP), para que el test pruebe que el tunel lleva los bytes.
		const net = require("net");
		const [, localPort, host, remotePort] = flag("-L").split(":");
		if (args[args.length - 1] === "app-sin-ssh") out("Error opening SSH connection: ssh is disabled\nFAILED", 1);
		net.createServer((client) => {
			const upstream = net.connect(Number(remotePort), host);
			client.pipe(upstream).pipe(client);
			upstream.on("error", () => client.destroy());
			client.on("error", () => upstream.destroy());
		}).listen(Number(localPort), "127.0.0.1");
		break;
	}
	case "curl":
		// Tuneles: instancia `pg` con un binding cuyo host/puerto vienen de FAKE_PG_PORT.
		if (args[1].startsWith("/v3/service_instances")) {
			out(JSON.stringify({ resources: args[1].includes("names=pg") ? [{ guid: "inst-pg" }] : [], pagination: { next: null } }));
		}
		if (args[1].startsWith("/v3/service_credential_bindings?")) {
			out(JSON.stringify({ resources: [{ guid: "bind-1", type: "app" }], pagination: { next: null } }));
		}
		if (args[1] === "/v3/service_credential_bindings/bind-1/details") {
			out(JSON.stringify({ credentials: { hostname: "127.0.0.1", port: process.env.FAKE_PG_PORT, password: "secreto" } }));
		}
		if (args[1].startsWith("/v3/organizations")) {
			out(JSON.stringify({ resources: [{ guid: "g1", name: s.org || "ORG" }], pagination: { next: null } }));
		}
		if (args[1].startsWith("/v3/spaces")) {
			const rel = { organization: { data: { guid: "g1" } } };
			out(JSON.stringify({ resources: [{ name: "prod", relationships: rel }, { name: "dev", relationships: rel }], pagination: { next: null } }));
		}
		out("{}");
		break;
	default:
		out(`fake cf: ${args.join(" ")}`);
}
