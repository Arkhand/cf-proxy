# cf-proxy

Proxy local hacia las destinations de un subaccount de BTP, usando los servicios
de Cloud Foundry. Sin cookies, sin BAS, sin `.env`.

```
http://localhost:3100/<NOMBRE_DESTINATION>/<path>
```

No hay nada hardcodeado: org, space, instancias de servicio, service keys, apps
y destinations se descubren en runtime. La misma carpeta sirve en cualquier
subaccount donde tengas sesión de `cf`.

---

## 1. Por qué existe

[`bas-proxy`](../bas-proxy/) funciona reutilizando la cookie de sesión de un dev
space de BAS. Es efectivo, pero la cookie caduca en horas y hay que recapturarla
a mano cada vez.

`cf-proxy` cambia el mecanismo de autenticación:

- Para destinations con **Basic, OAuth2 o sin auth**: usa las credenciales de
  las instancias `destination` y `connectivity` del space. Son credenciales de
  aplicación: no caducan y las obtiene solo con el `cf` CLI.
- Para destinations con **PrincipalPropagation**: hace un login de usuario
  contra un XSUAA propio (browser → IdP → callback en el proxy). El JWT de
  usuario dura horas y se renueva solo con el refresh token durante ~30 días.

## 2. Cómo funciona

Seis pasos, todos automáticos y visibles en la consola:

```
[1/6] cf target                   -> ¿hay sesión? ¿qué org/space?
[2/6] cf curl /v3/service_instances
                                  -> ¿qué instancias hay? ¿están las propias (cf-dest-*)?
[3/6] cf service-keys / service-key
                                  -> credenciales: propias primero; si no, cualquier key usable
[4/6] ~/.cf-proxy/                -> ¿hay sesión de usuario? (solo para PrincipalPropagation)
[5/6] sonda TCP + cf ssh          -> ¿se llega al Connectivity Proxy? si no, túnel
[6/6] http.createServer           -> proxy escuchando en localhost
```

Por cada request:

1. El primer segmento del path se toma como nombre de destination.
2. Se pide la configuración completa al Destination Service (cacheado). Si hay
   sesión de usuario, va en `X-user-token` para las que la necesitan.
3. Se aplica la autenticación que la destination declare.
4. Si es `OnPremise`, se enruta por el Connectivity Proxy con los headers que
   el Cloud Connector espera; para PrincipalPropagation, además el JWT del
   usuario en `SAP-Connectivity-Authentication`.

| Archivo | Responsabilidad |
|---|---|
| [`lib/cf.js`](lib/cf.js) | Único módulo que ejecuta `cf`. Devuelve datos normalizados. |
| [`lib/discover.js`](lib/discover.js) | Busca instancias y keys. Las propias (`cf-dest-*`) primero. |
| [`lib/auth.js`](lib/auth.js) | Login de usuario (authorization_code) y cache de tokens. |
| [`lib/destinations.js`](lib/destinations.js) | Tokens XSUAA + listar/resolver destinations, con cache. |
| [`lib/proxy.js`](lib/proxy.js) | El servidor HTTP: ruteo, auth, on-premise, login, página. |
| [`server.js`](server.js) | Orquesta los 6 pasos y parsea los flags. |
| [`mta.yaml`](mta.yaml) | Recursos propios en CF: xsuaa, destination, connectivity, app SSH. |
| [`webapp/index.html`](webapp/index.html) | Página de diagnóstico (UI5). |

Sin dependencias: solo Node ≥ 16 y el `cf` CLI en el PATH. Para `npm run
deploy` hace falta además `mbt` y el plugin `multiapps` de `cf`.

## 3. Uso

```bash
cf login -a https://api.cf.<region>.hana.ondemand.com --sso
cf target -o <org> -s <space>

cd cf-proxy
npm run deploy    # una vez por space: crea los recursos cf-dest-* (ver §5)
npm run list      # ver qué destinations hay y cuáles van a funcionar
npm start         # levantar el proxy en localhost:3100 (abre la página)
```

Sin `npm run deploy` también funciona: reutiliza las instancias que ya haya en
el space. Lo único que no va a funcionar sin el deploy es PrincipalPropagation.

En el `ui5.yaml` del proyecto:

```yaml
- path: /sap/opu/odata/sap/API_BILLOFMATERIAL_SRV
  pathPrefix: /S4_PP_API_BILLOFMATERIAL_SRV/sap/opu/odata/sap/API_BILLOFMATERIAL_SRV
  url: http://localhost:3100
```

### Flags

| Flag | Qué hace |
|---|---|
| `--list` | Lista las destinations agrupadas por si van a funcionar o no, y sale. |
| `--login` | Arranca y abre el login de usuario en el browser. |
| `--port <n>` | Puerto local. Default `3100`. Si se cambia, ver §6. |
| `--xsuaa <instancia>` | Usar otra instancia de xsuaa para el login (default `cf-dest-xsuaa`). |
| `--create-keys` | Permite crear una service key (`cf-dest-key`) en instancias ajenas si ninguna sirve. |
| `--tunnel` | Fuerza el túnel `cf ssh -L`. Es automático si existe `cf-dest-app`. |
| `--tunnel-app <app>` | App a usar para el túnel. |
| `--tunnel-port <n>` | Puerto local del túnel. Default `20003`. |
| `--connectivity-proxy host:port` | Usar un Connectivity Proxy que ya sea alcanzable. |
| `--no-open` | No abrir la página de diagnóstico al arrancar. |

### Página de diagnóstico

Al arrancar se abre `http://localhost:3100/`: una página UI5 (un solo HTML,
sin build) con:

- los URLs de uso, listado, detalle, estado y login;
- botón **Chequear estado**, y **Iniciar / Cerrar sesión**;
- tabla filtrable con todas las destinations, marcando cuáles van a funcionar
  (OK / requiere sesión / requiere túnel / requiere XSUAA propio);
- botón **Detalles** por destination, que muestra el JSON resuelto con la misma
  forma que devuelve `getDestination()` de `@sap-cloud-sdk/connectivity`.
  Los secretos van ocultos; el check **Mostrar secretos** los revela;
- la fila **Target CF** (org / space / usuario): es el subaccount que se toca
  al crear, editar o eliminar;
- **Nueva destination**, y **Editar** / **Eliminar** por fila. Ver abajo.

### Crear, editar y eliminar destinations

La página escribe sobre el subaccount **entero** del target actual de CF, que
puede ser de un cliente con cientos de destinations de otros proyectos. Por eso
toda escritura pasa por un aviso explícito y una confirmación:

1. **Crear / Editar** abren un formulario: campos comunes (nombre, URL, tipo,
   proxy, autenticación), los campos propios del tipo de autenticación elegido
   (cambian al cambiar el tipo), y **Parámetros adicionales** como lista
   clave/valor para todo lo demás (`sap-client`, `WebIDEEnabled`, `HTML5.*`…).
   En editar viene precargada la definición guardada **sin los secretos**
   (`Password`, `clientSecret`…): dejar el campo vacío los conserva.
2. **Revisar cambios** pide al proxy un *preview*: no escribe nada y devuelve el
   diff propiedad por propiedad contra lo guardado.
3. El diálogo de confirmación dice sin rodeos *qué* se va a hacer y *dónde*
   ("ATENCIÓN: vas a MODIFICAR la destination X en el subaccount org / space"),
   muestra el diff, y el botón **Confirmar y escribir** solo se habilita cuando
   se tipea el nombre exacto de la destination.
4. **Eliminar** muestra la definición, avisa que no hay papelera ni deshacer y
   que se hace **bajo tu propia responsabilidad**, y también exige tipear el
   nombre. El proxy devuelve la definición borrada como `backup` (y la deja en
   su consola, sin secretos) para poder recrearla con **Nueva destination**.

Detalles de comportamiento:

- **Editar hace merge**: lo que no se manda se conserva. Quitar un parámetro
  (vaciar un campo, sacar una fila de adicionales, o cambiar el tipo de
  autenticación, que saca los campos del tipo anterior) se manda como `null`,
  y el preview lo marca como **(SE QUITA)** antes de confirmar.
- El nombre no se edita: cambiarlo sería crear otra destination.
- El catálogo de tipos (`AUTH_TYPES` en la página) replica las tablas
  *Required* / *Optional* de SAP Help para los 15 tipos de autenticación HTTP
  (verificado el 2026-09-20 contra `SAP-docs/btp-connectivity`), más los
  campos TLS del servidor (`TrustAll`, `TrustStore*`, `HostnameVerifier`).
  Las propiedades con prefijo libre (`URL.headers.X`, `URL.queries.X`,
  `tokenService.body.X`…) se cargan como parámetros adicionales.
- **Si mañana cambia la estructura**: los tipos de autenticación y sus campos
  son datos en la página (`AUTH_TYPES`), no código: un tipo nuevo es una línea.
  Un tipo que la página no conoce se acepta igual (el combo admite texto
  libre) y sus propiedades van a adicionales. Una propiedad desconocida en una
  destination existente aparece en adicionales y se conserva. El servidor no
  tiene esquema (valida solo `Name`, `URL` y `Authentication`), así que la API
  funciona aunque la página quede vieja.
- **Crear** falla si el nombre ya existe (409), y **Editar** si no existe
  (404): un "crear" nunca pisa una destination ajena por accidente.
- La confirmación es un guard **del servidor** (`confirm` = nombre exacto en el
  body), no de la página: un `fetch` suelto sin `confirm` recibe 400 y no
  escribe. Además el body debe ser `application/json`, lo que fuerza preflight
  CORS y bloquea escrituras desde páginas de otro origen.

### Endpoints propios

- `GET /` — la página de diagnóstico.
- `GET /__destinations` — lista completa con tipo de auth y proxy.
- `GET /__destination/<nombre>` — detalle resuelto (forma del Cloud SDK).
  Secretos enmascarados; `?reveal=1` los muestra.
- `GET /__health` — estado del proxy, target de CF, acceso on-premise y sesión de usuario.
- `GET /__login` — redirige al login de XSUAA. `GET /__logout` borra la sesión.
- `GET /__callback` — a donde vuelve XSUAA. No se llama a mano.

Edición (todos con body `application/json`; las escrituras exigen
`confirm` igual al nombre exacto):

- `GET /__destinations/<nombre>/raw` — definición guardada, sin secretos.
- `POST /__destinations/preview` — `{ action: "create"|"update", config, replace? }`.
  No escribe; devuelve `warning`, `exists`, `willSend` y (en update) `changes`.
- `POST /__destinations` — `{ config, confirm }`. Crea; 409 si ya existe.
- `PUT /__destinations/<nombre>` — `{ config, confirm, replace? }`. Actualiza
  (merge por default; una propiedad en `null` se quita); 404 si no existe.
  `replace: true` manda `config` tal cual y descarta el resto.
- `DELETE /__destinations/<nombre>` — `{ confirm }`. Elimina; devuelve
  `backup` con la definición borrada (secretos enmascarados).

Ejemplo desde la terminal, para una destination `MI_API`:

```bash
curl -X PUT http://localhost:3100/__destinations/MI_API \
  -H "content-type: application/json" \
  -d '{ "config": { "URL": "https://nuevo.host" }, "confirm": "MI_API" }'
```

## 4. Qué destinations funcionan

| Authentication | Internet | OnPremise |
|---|---|---|
| `NoAuthentication` | ✅ | ✅ con túnel |
| `BasicAuthentication` | ✅ | ✅ con túnel |
| `OAuth2ClientCredentials` | ✅ | ✅ con túnel |
| `OAuth2UserTokenExchange` / `OAuth2JWTBearer` | ✅ con sesión de usuario | ✅ con sesión + túnel |
| `PrincipalPropagation` | — | ⚠️ implementado; ver §6 |

`npm run list` te lo dice por destination, sin adivinar.

Verificado el 2026-09-04 en `bms-bld/BLD`: Basic on-prem
(`S4_BASIC_ZSB_WFTASK_UI2/$metadata`) devuelve `200` desde el S/4 por el
túnel. El proxy manda siempre el header `sap-client` de la destination: sin
él el ICM usa el mandante por default y el logon falla.

## 5. Los recursos propios (`mta.yaml`)

`npm run deploy` despliega, una vez por space, cuatro cosas con nombre fijo:

| Nombre | Qué es | Para qué |
|---|---|---|
| `cf-dest-xsuaa` | instancia `xsuaa` (plan `application`) | Login de usuario. Es la única pieza que **no** se puede reutilizar de otra app: sus `redirect-uris` apuntan a `http://localhost`. |
| `cf-dest-destination` | instancia `destination` (`lite`) | Listar y resolver destinations. |
| `cf-dest-connectivity` | instancia `connectivity` (`lite`) | Llegar al Cloud Connector. |
| `cf-dest-app` | app Node mínima, sin ruta, con SSH | Salto para el túnel. No sirve tráfico. |

Las tres instancias vienen con una service key `cf-dest-key`. Si `cf-proxy`
las encuentra, las usa directo y no revisa nada más del space.

Nada del subaccount se modifica: ni destinations, ni otras apps, ni sus XSUAA.
`npm run undeploy` borra todo (app, instancias y keys).

Requisitos para desplegar: rol `SpaceDeveloper`, cuota para tres instancias y
128 MB de memoria, y SSH permitido en el space (`cf space-ssh-allowed <space>`).

## 6. PrincipalPropagation: el login de usuario

El Cloud Connector solo acepta una llamada con principal propagation si recibe
un JWT del **usuario final** emitido por el XSUAA del subaccount. Las
credenciales de servicio (`client_credentials`) identifican a una aplicación,
no a una persona; por eso no alcanzan.

`cf-proxy` consigue ese JWT igual que lo haría BAS: con un login en el browser.

```
browser ──► /__login ──► XSUAA /oauth/authorize ──► IdP (SSO) ──► /__callback?code
                                                                       │
                                            /oauth/token ◄─────────────┘
                                                 │
                                    access_token + refresh_token
                                                 │
                                        ~/.cf-proxy/user-token-*.json
```

- La sesión se guarda en `~/.cf-proxy/` (permisos solo del usuario). Al
  arrancar, el proxy la reutiliza; cuando el access token vence, lo renueva
  con el refresh token sin intervención. Hay que volver a loguearse recién
  cuando vence el refresh token (30 días).
- Con sesión, cada request a una `S4_PP_*` lleva
  `SAP-Connectivity-Authentication: Bearer <JWT>` por el túnel, y el S/4
  registra la llamada con **tu** usuario (no con uno técnico).
- El `redirect_uri` es `http://localhost:3100/__callback`. Si se cambia el
  puerto con `--port`, hay que agregar el nuevo puerto en
  [`xs-security.json`](xs-security.json) y volver a desplegar.

### Estado actual: llega al S/4, pero recibe 401

Probado el 2026-09-04 contra `S4_PP_API_BILLOFMATERIAL_SRV` (`s4conpp:443`,
CC `BLD_CND`, S/4 `CON/030`):

- El JWT trae `user_name`, `email` y `origin=sap.custom`. El Connectivity
  Proxy lo valida: con un token inválido responde `400 No issuer found in
  token`; con el nuestro reenvía.
- El request atraviesa túnel, Connectivity Proxy y Cloud Connector y llega al
  S/4, que responde `401` con `WWW-Authenticate: Basic`.
- **Con o sin identidad, el S/4 responde igual.** Y da lo mismo mandar el JWT
  en `SAP-Connectivity-Authentication` (como hace el Cloud SDK) o
  intercambiarlo por un token de `connectivity` (`jwt-bearer`) en
  `Proxy-Authorization`.

Eso ubica el problema fuera del proxy. Qué revisar, en orden:

1. **CC → subaccount → Audit / Trace** con principal propagation activado:
   dice si para `s4conpp:443` se generó un certificado, con qué subject, o por
   qué se descartó la identidad.
2. **CC → Cloud To On-Premise → `s4conpp:443` → Principal Type**: tiene que ser
   `X.509 Certificate (General Usage)` o `Strict`. Con `None` el CC reenvía sin
   certificado y el S/4 pide Basic — exactamente lo que se ve.
3. **CC → Principal Propagation → Subject Pattern** y la sincronización de
   IdPs: el subject se arma con claims del JWT. Comparar con lo que llega desde
   BAS (mismo usuario, mismo IdP, distinto cliente XSUAA).
4. **S/4 → `CERTRULE` / `SM21`**: si el CC sí manda certificado, el mapeo al
   usuario no está o está solo para el subject que genera BAS.

Mientras tanto, para `S4_PP_*` sirve [`bas-proxy`](../bas-proxy/).

## 7. On-premise y el túnel

El Connectivity Proxy (`connectivityproxy.internal.cf.<region>...:20003`) es
quien habla con el Cloud Connector. **Solo es alcanzable desde adentro de CF.**

El proxy lo resuelve con un port-forward SSH a través de una app del space:

```
PC                                       Cloud Foundry
────────────────────────────             ──────────────────────────────────

cf-proxy ──► localhost:20003 ──ssh──► cf-dest-app ──► connectivityproxy:20003
                                                              │
                                                              ▼
                                                       Cloud Connector
                                                              │
                                                              ▼
                                                          S/4HANA
```

Si existe `cf-dest-app` (del deploy), el túnel se abre solo. Si no, con
`--tunnel` se busca cualquier app `STARTED` con SSH habilitado, o se indica
una con `--tunnel-app`. El túnel se cierra al cortar el proxy con Ctrl+C.

## 8. Límites

- **Solo para desarrollo.** El deploy de las apps sigue usando sus propias
  destinations; esto no interviene.
- **Requiere permisos de `cf`.** `SpaceDeveloper` para leer service keys y
  para desplegar el MTA.
- **Las credenciales de servicio son de aplicación.** Con Basic/OAuth2, el S/4
  ve el usuario de la destination. Con PrincipalPropagation, te ve a vos.
- Las credenciales de servicio se leen de `cf` en memoria en cada arranque; no
  se escriben en disco. Lo único persistido es la sesión de usuario en
  `~/.cf-proxy/`.

## 9. Operación diaria

| Síntoma | Causa | Solución |
|---|---|---|
| `No hay sesion de CF activa` | Token de `cf` vencido | `cf login --sso` |
| `Ninguna instancia de destination tiene una key usable` | Solo hay keys tipo `content` | `npm run deploy` o `npm run setup` |
| `401 PrincipalPropagation necesita el JWT del usuario` | Sin sesión | Abrir `/__login` o `npm run login` |
| `501 No hay un XSUAA propio` | No se hizo el deploy | `npm run deploy` |
| `501 ... requiere el Connectivity Proxy` | Destination on-prem sin túnel | `npm run deploy` (túnel automático) o `--tunnel` |
| `Ninguna app STARTED tiene SSH habilitado` | Sin `cf-dest-app` ni otra con SSH | `npm run deploy` o `cf enable-ssh <app> && cf restart <app>` |
| Login vuelve con `invalid_redirect` | Puerto distinto de 3100 | Agregar el puerto en `xs-security.json` y redesplegar |
| `403 Access denied to resource ... cloud connector` | El path no está expuesto en el CC | Revisar la URL: la destination ya incluye su base path |
| `401` del S/4 con `WWW-Authenticate: Basic` en una PP | El CC no propagó o el S/4 no mapeó | Ver §6, "Estado actual" |
| Página ICM "Anmeldung fehlgeschlagen" en una Basic | Mandante equivocado o credenciales vencidas | Ver `sap-client` en Detalles; probar el usuario de la destination |
| `404 La destination X no existe` | Nombre mal escrito | `GET /__destinations` |
| `400 CONFIRMACION REQUERIDA para ...` | Escritura sin `confirm` | Mandar `confirm` con el nombre exacto (la página lo hace al tipearlo) |
| `400 El body tiene que ser JSON` | Falta `content-type: application/json` | Agregar el header |
