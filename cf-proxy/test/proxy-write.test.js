/**
 * Test de las rutas de edicion del proxy (lib/proxy.js).
 *
 * Levanta el servidor real con un `destClient` STUB que solo anota con que
 * lo llamaron. No hay red hacia BTP ni service keys: verifica el ruteo, la
 * exigencia de content-type, que `confirm` y `replace` lleguen enteros a la
 * capa de abajo, que los secretos no salgan hacia el browser, y que el
 * contexto mutable (cambio de org/space) se refleje en el acto.
 *
 * Uso:  node test/proxy-write.test.js
 */
const http = require("http");
const { createProxyServer } = require("../lib/proxy");

// --- Stub del cliente: registra llamadas y devuelve respuestas fijas -------
const calls = [];
const stub = {
	list: async () => [{ name: "A", url: "https://a", auth: "NoAuthentication", proxyType: "Internet" }],
	resolve: async (name) => {
		calls.push({ fn: "resolve", name });
		if (name !== "EXISTE") { throw new Error(`La destination \`${name}\` no existe en este subaccount.`); }
		// Host inexistente a proposito: el test verifica el diagnostico, no la red.
		return { config: { Name: name, URL: "https://no-existe.invalid", Authentication: "NoAuthentication", ProxyType: "Internet" }, authTokens: [] };
	},
	raw: async (name) => {
		calls.push({ fn: "raw", name });
		return name === "EXISTE"
			? { Name: "EXISTE", URL: "https://x", Authentication: "BasicAuthentication", User: "u", Password: "SECRETO-REAL" }
			: null;
	},
	preview: async (action, config, opts) => {
		calls.push({ fn: "preview", action, config, opts });
		return {
			action, name: config.Name, exists: true, warning: "aviso",
			changes: [
				{ property: "URL", before: "https://x", after: config.URL },
				{ property: "Password", before: "SECRETO-REAL", after: "OTRO-SECRETO" },
				{ property: "ExtraProp", before: "algo", after: "(SE PIERDE)" }
			],
			willSend: { ...config, Password: "OTRO-SECRETO" }
		};
	},
	create: async (config, opts) => {
		calls.push({ fn: "create", config, opts });
		if (opts.confirm !== config.Name) throw new Error("CONFIRMACION REQUERIDA para CREAR");
		return { name: config.Name, created: true };
	},
	update: async (config, opts) => {
		calls.push({ fn: "update", config, opts });
		return { name: config.Name, updated: true };
	},
	remove: async (name, opts) => {
		calls.push({ fn: "remove", name, opts });
		if (opts.confirm !== name) throw new Error("CONFIRMACION REQUERIDA para ELIMINAR");
		return { name, deleted: true, backup: { Name: name, URL: "https://x", Password: "SECRETO-REAL" } };
	}
};

const auth = { configured: false, reason: "sin xsuaa", status: () => ({ configured: false }), getUserToken: async () => null };

// Contexto mutable: lo mismo que arma server.js. `retarget` imita el cambio
// de org/space reemplazando el cliente, para verificar que el server lo lee
// en cada request y no lo capturo al crearse.
const ctx = {
	destClient: stub, connectivity: null, connTokenProvider: null, connectivityNote: "",
	cfTarget: { org: "ORG-TEST", space: "SPACE-TEST", user: "yo" }
};

const otherStub = { ...stub, list: async () => [{ name: "OTRA-SUBACCOUNT", url: "https://b", auth: "NoAuthentication", proxyType: "Internet" }] };

async function retarget(org, space) {
	calls.push({ fn: "retarget", org, space });
	if (org === "NO-EXISTE") { return { ok: false, error: `No se pudo apuntar a ${org}/${space}.` }; }
	ctx.destClient = otherStub;
	ctx.cfTarget = { org, space, user: "yo" };
	return { ok: true };
}

const server = createProxyServer({ ctx, auth, onRetarget: retarget, log: () => {} });

/** Request minimo contra el server de test; devuelve { status, json }. */
function call(port, method, path, body, contentType = "application/json") {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body);
		const req = http.request(
			{ host: "127.0.0.1", port, method, path, headers: data ? { "content-type": contentType, "content-length": Buffer.byteLength(data) } : {} },
			(res) => {
				let out = "";
				res.on("data", (c) => (out += c));
				res.on("end", () => resolve({ status: res.statusCode, json: out ? JSON.parse(out) : null }));
			}
		);
		req.on("error", reject);
		if (data) req.write(data);
		req.end();
	});
}

server.listen(0, async () => {
	const port = server.address().port;
	let failed = 0;
	const ok = (n, cond) => { if (!cond) failed++; console.log((cond ? "PASS  " : "FAIL  ") + n); };
	const last = () => calls[calls.length - 1];
	let r;

	// --- /__health trae el target ------------------------------------------
	r = await call(port, "GET", "/__health");
	ok("/__health incluye target org/space", r.json.target && r.json.target.org === "ORG-TEST" && r.json.target.space === "SPACE-TEST");
	ok("/__health avisa que se puede cambiar de target", r.json.canRetarget === true);

	// --- El listado GET sigue funcionando (sin regresion) --------------------
	r = await call(port, "GET", "/__destinations");
	ok("GET /__destinations sigue listando", r.status === 200 && r.json.count === 1);

	// --- raw: precarga del editor sin secretos -------------------------------
	r = await call(port, "GET", "/__destinations/EXISTE/raw");
	ok("GET raw devuelve la definicion", r.status === 200 && r.json.Name === "EXISTE" && r.json.User === "u");
	ok("GET raw OMITE el Password (no lo enmascara: lo saca)", !("Password" in r.json));
	r = await call(port, "GET", "/__destinations/NO_EXISTE/raw");
	ok("GET raw de inexistente da 404", r.status === 404 && /no existe/.test(r.json.error));

	// --- content-type obligatorio -------------------------------------------
	calls.length = 0;
	r = await call(port, "POST", "/__destinations", { config: { Name: "X" }, confirm: "X" }, "text/plain");
	ok("POST con text/plain se rechaza (400)", r.status === 400 && /application\/json/.test(r.json.error));
	ok("POST con text/plain NO llega al cliente", !calls.some((c) => c.fn === "create"));

	// --- preview: pasa todo y oculta secretos del diff -----------------------
	calls.length = 0;
	r = await call(port, "POST", "/__destinations/preview", { action: "update", config: { Name: "EXISTE", URL: "https://nueva" }, replace: true });
	ok("preview responde 200", r.status === 200);
	ok("preview pasa action/config/replace al cliente", last().fn === "preview" && last().action === "update" && last().config.URL === "https://nueva" && last().opts.replace === true);
	const pw = r.json.changes.find((c) => c.property === "Password");
	ok("preview OCULTA before/after de propiedades secretas", pw.before === "…(oculto)" && pw.after === "…(oculto)");
	const ex = r.json.changes.find((c) => c.property === "ExtraProp");
	ok("preview deja ver el marcador (SE PIERDE)", ex.after === "(SE PIERDE)");
	const url = r.json.changes.find((c) => c.property === "URL");
	ok("preview deja ver valores no secretos", url.after === "https://nueva");
	ok("preview oculta secretos en willSend", /oculto/.test(r.json.willSend.Password));
	ok("preview NO deja ver ni un caracter del secreto", r.json.willSend.Password === "…(oculto)");
	ok("preview no escribe (no llamo create ni update)", !calls.some((c) => c.fn === "create" || c.fn === "update"));

	// --- create: confirm viaja hasta la capa de abajo ------------------------
	calls.length = 0;
	r = await call(port, "POST", "/__destinations", { config: { Name: "NUEVA", URL: "https://n", Authentication: "NoAuthentication" } });
	ok("create SIN confirm devuelve 400 con el mensaje del guard", r.status === 400 && /CONFIRMACION REQUERIDA/.test(r.json.error));
	r = await call(port, "POST", "/__destinations", { config: { Name: "NUEVA", URL: "https://n", Authentication: "NoAuthentication" }, confirm: "NUEVA" });
	ok("create CON confirm devuelve 201", r.status === 201 && r.json.created === true);
	ok("create pasa confirm al cliente", last().fn === "create" && last().opts.confirm === "NUEVA");

	// --- update: el nombre sale de la URL, no del body -----------------------
	calls.length = 0;
	r = await call(port, "PUT", "/__destinations/EXISTE", { config: { Name: "OTRO_NOMBRE", URL: "https://z" }, confirm: "EXISTE", replace: false });
	ok("PUT devuelve 200", r.status === 200 && r.json.updated === true);
	ok("PUT usa el nombre de la URL aunque el body traiga otro", last().config.Name === "EXISTE");
	ok("PUT pasa confirm y replace", last().opts.confirm === "EXISTE" && last().opts.replace === false);

	// --- delete: confirm obligatorio, backup sin secretos ---------------------
	calls.length = 0;
	r = await call(port, "DELETE", "/__destinations/EXISTE", { confirm: "" });
	ok("DELETE sin confirm devuelve 400 con el mensaje del guard", r.status === 400 && /CONFIRMACION REQUERIDA/.test(r.json.error));
	r = await call(port, "DELETE", "/__destinations/EXISTE", { confirm: "EXISTE" });
	ok("DELETE con confirm devuelve 200 deleted", r.status === 200 && r.json.deleted === true);
	ok("DELETE pasa nombre de la URL y confirm al cliente", last().fn === "remove" && last().name === "EXISTE" && last().opts.confirm === "EXISTE");
	ok("DELETE devuelve backup con secretos ocultos del todo", r.json.backup.URL === "https://x" && r.json.backup.Password === "…(oculto)");
	r = await call(port, "DELETE", "/__destinations/EXISTE", { confirm: "EXISTE" }, "text/plain");
	ok("DELETE con text/plain se rechaza", r.status === 400);

	// --- ruta de edicion desconocida no cae al ruteo generico ----------------
	r = await call(port, "PATCH", "/__destinations/EXISTE", {});
	ok("PATCH (no implementado) da 405, no intenta proxyar", r.status === 405);

	// --- body invalido --------------------------------------------------------
	r = await new Promise((resolve) => {
		const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/__destinations/preview", headers: { "content-type": "application/json" } }, (res) => {
			let out = ""; res.on("data", (c) => (out += c)); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(out) }));
		});
		req.end("{esto no es json");
	});
	ok("JSON invalido da 400 con mensaje claro", r.status === 400 && /JSON invalido/.test(r.json.error));

	// --- cambio de org/space: el contexto es mutable y se lee por request ----
	calls.length = 0;
	r = await call(port, "POST", "/__target", { org: "OTRO-ORG" });
	ok("POST /__target sin space da 400", r.status === 400 && /space/.test(r.json.error));
	ok("POST /__target incompleto no reapunta", !calls.some((c) => c.fn === "retarget"));

	r = await call(port, "POST", "/__target", { org: "NO-EXISTE", space: "X" });
	ok("POST /__target que falla devuelve 400 con el motivo", r.status === 400 && /No se pudo apuntar/.test(r.json.error));
	r = await call(port, "GET", "/__health");
	ok("un retarget fallido NO cambia el target visible", r.json.target.org === "ORG-TEST");

	r = await call(port, "GET", "/__destinations");
	ok("antes del retarget lista el subaccount viejo", r.json.destinations[0].name === "A");
	r = await call(port, "POST", "/__target", { org: "OTRO-ORG", space: "OTRO-SPACE" });
	ok("POST /__target devuelve 200 con el target nuevo", r.status === 200 && r.json.target.org === "OTRO-ORG");
	r = await call(port, "GET", "/__destinations");
	ok("DESPUES del retarget lista el subaccount nuevo (contexto mutable)", r.json.destinations[0].name === "OTRA-SUBACCOUNT");
	r = await call(port, "GET", "/__health");
	ok("/__health refleja el target nuevo", r.json.target.org === "OTRO-ORG" && r.json.target.space === "OTRO-SPACE");

	// Restaurar para no arrastrar estado a los tests que siguen.
	ctx.destClient = stub;
	ctx.cfTarget = { org: "ORG-TEST", space: "SPACE-TEST", user: "yo" };

	// --- probar una destination ---------------------------------------------
	r = await call(port, "GET", "/__test/EXISTE");
	ok("GET /__test responde con etapa y ms", r.status === 200 && typeof r.json.stage === "string" && typeof r.json.ms === "number");
	ok("/__test pasa resolve/auth/route y falla recien al conectar", r.json.stage === "connect" && r.json.ok === false);
	ok("/__test informa la URL que intento", /no-existe\.invalid/.test(r.json.url || ""));
	r = await call(port, "GET", "/__test/NO_EXISTE_TEST");
	// Se compara el MENSAJE, no solo la etapa: un error de plomeria (p.ej. llamar
	// mal al cliente) tambien cae en "resolve" y pasaria desapercibido.
	ok("/__test de inexistente corta en resolve con el error del cliente",
		r.json.stage === "resolve" && r.json.ok === false && /no existe en este subaccount/.test(r.json.error));
	ok("/__test llamo al cliente de verdad", calls.some((c) => c.fn === "resolve" && c.name === "NO_EXISTE_TEST"));
	ok("/__test nunca escribe", !calls.some((c) => c.fn === "create" || c.fn === "update" || c.fn === "remove"));

	console.log("");
	console.log(failed ? failed + " test(s) FALLARON" : "Todos los tests pasaron");
	server.close();
	process.exit(failed ? 1 : 0);
});
