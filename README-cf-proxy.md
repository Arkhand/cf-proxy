# cf-proxy

Proxy local hacia las destinations de un subaccount de BTP, usando los servicios
de Cloud Foundry. Sin cookies, sin BAS, sin `.env`.

```
http://localhost:3100/<NOMBRE_DESTINATION>/<path>
```

No hay nada hardcodeado: instancias de servicio, service keys, apps y
destinations se descubren en runtime. Lo único que se guarda es el **perfil**:
una subcuenta de cliente (api, org, space), su puerto y su propia sesión de
`cf`.

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

Siete pasos, todos automáticos y visibles en la consola (o en
`cf-proxy logs <perfil>`):

```
[0]   perfil + lock + puerto      -> ¿existe el perfil? ¿ya corre? ¿el puerto está libre?
[1/6] cf target                   -> ¿hay sesión EN EL PERFIL? apunta a su org/space
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
| [`lib/profiles.js`](lib/profiles.js) | Perfiles: una subcuenta = un perfil, puertos únicos. |
| [`lib/runs.js`](lib/runs.js) | Registro de corridas y lock por perfil (`~/.cf-proxy/runs`). |
| [`bin/cf-proxy.js`](bin/cf-proxy.js) | La consola: perfiles, login, start/stop/ps/logs, `cf` del perfil. |
| [`lib/cf.js`](lib/cf.js) | Único módulo que ejecuta `cf`, siempre con el CF_HOME del perfil. |
| [`lib/discover.js`](lib/discover.js) | Busca instancias y keys. Las propias (`cf-dest-*`) primero. |
| [`lib/auth.js`](lib/auth.js) | Login de usuario (authorization_code) y cache de tokens. |
| [`lib/destinations.js`](lib/destinations.js) | Tokens XSUAA + listar/resolver destinations, con cache. |
| [`lib/proxy.js`](lib/proxy.js) | El servidor HTTP: ruteo, auth, on-premise, login, página. |
| [`server.js`](server.js) | Orquesta los pasos de una corrida. |
| [`mta.yaml`](mta.yaml) | Recursos propios en CF: xsuaa, destination, connectivity, app SSH. |
| [`webapp/index.html`](webapp/index.html) | Página de diagnóstico (UI5). |

Sin dependencias: solo Node ≥ 16 y el `cf` CLI en el PATH. Para desplegar el
MTA hace falta además `mbt` (o el `.mtar` del launcher) y el plugin `multiapps`
de `cf`.

## 3. Uso

```bash
cd cf-proxy
# una vez por cliente: el perfil (puerto libre si no se indica) y su login
node bin/cf-proxy.js profiles add --name acme --title "ACME" \
     --api https://api.cf.<region>.hana.ondemand.com --org <org> --space <space> --auth sso
node bin/cf-proxy.js login acme

# una vez por space: los recursos cf-dest-* (ver §5)
npm run build:mta
node bin/cf-proxy.js cf acme -- deploy mta_archives/cf-dest_1.0.0.mtar -f

node bin/cf-proxy.js start acme      # en segundo plano; devuelve la URL
node bin/cf-proxy.js ps              # qué corre: título, usuario, org/space, puerto, estado
node bin/cf-proxy.js logs acme -f    # la salida de la corrida
node bin/cf-proxy.js stop acme
```

Sin el deploy también funciona: reutiliza las instancias que ya haya en el
space. Lo único que no va a funcionar sin el deploy es PrincipalPropagation.

### Perfiles, sesiones y corridas

- **Una subcuenta = un perfil.** `(api, org)` no se repite entre perfiles, y el
  **puerto tampoco**. Un perfil que choca (p.ej. importado del launcher viejo,
  todos en 3100) queda marcado y no arranca hasta corregirlo:
  `profiles edit <p> --port auto`.
- **Cada perfil tiene su CF_HOME** (`~/.cf-proxy/profiles/<p>/cf-home`). El
  proxy nunca usa ni cambia la sesión global de `cf`: tu terminal sigue
  apuntando donde estaba, y dos clientes pueden correr a la vez. Los plugins
  (`multiapps`) se siguen leyendo de `~/.cf` vía `CF_PLUGIN_HOME`.
- **Una corrida por perfil.** `start` de un perfil que ya corre devuelve su URL
  (`already: true`) en vez de levantar otro. Sirve para que dos sesiones de IA
  pidan el mismo cliente sin pisarse. Dos `start` simultáneos terminan en un
  solo proceso: el registro (`~/.cf-proxy/runs/<p>.json`) es también el lock.
- **`cf <p> -- <args>`** corre cualquier comando de `cf` con la sesión del
  perfil e imprime antes `[cf-proxy] perfil X -> api / org / space`. Se niega a
  apuntar a otro org: el deploy al cliente equivocado no se puede repetir por
  acá.
- `--json` en cualquier comando imprime un solo objeto (`{ok, ...}`); es lo que
  usan el launcher y las skills. Códigos de salida: 2 uso, 3 ya corre, 4 sin
  sesión, 5 puerto ocupado, 6 faltan recursos en el space.

En el `ui5.yaml` del proyecto:

```yaml
- path: /sap/opu/odata/sap/API_BILLOFMATERIAL_SRV
  pathPrefix: /S4_PP_API_BILLOFMATERIAL_SRV/sap/opu/odata/sap/API_BILLOFMATERIAL_SRV
  url: http://localhost:3100
```

### Flags de `server.js`

`server.js` es lo que `start` lanza en segundo plano. Se puede correr en primer
plano con `node server.js --profile <p>`. Puerto y flags (`tunnel`, `login`,
`create_keys`, `open_browser`) salen del perfil; estos flags los suman:

| Flag | Qué hace |
|---|---|
| `--profile <p>` | **Obligatorio.** Sin él, sale con código 2 y lista los perfiles. |
| `--list` | Lista las destinations agrupadas por si van a funcionar o no, y sale. |
| `--login` | Arranca y abre el login de usuario en el browser. |
| `--xsuaa <instancia>` | Usar otra instancia de xsuaa para el login (default `cf-dest-xsuaa`). |
| `--create-keys` | Permite crear una service key (`cf-dest-key`) en instancias ajenas si ninguna sirve. |
| `--tunnel` | Fuerza el túnel `cf ssh -L`. Es automático si existe `cf-dest-app`. |
| `--tunnel-app <app>` | App a usar para el túnel. |
| `--tunnel-port <n>` | Puerto local del túnel. Default: uno libre (dos proxies no pueden compartirlo). |
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
  al crear, editar o eliminar, con botón **Cambiar** para saltar a otro
  org/space sin reiniciar (ver abajo);
- botón **Probar** por destination: un GET real por el camino del proxy;
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

### Cambiar de space sin reiniciar

El botón **Cambiar** al lado de *Target CF* lista los spaces del org del perfil
y reapunta la sesión **del perfil** (`cf target -s`) sin cortar el proxy: se
rehace el descubrimiento de servicios y se reabre el túnel. No modifica nada en
BTP, ni el target de la terminal ni el de otros proxies.

El org queda fijo: un perfil es una subcuenta. `POST /__target` con otro org
responde **409**; para otro cliente, otro perfil.

Si el nuevo space no tiene una instancia de `destination` usable, el cambio se
revierte y el target vuelve a donde estaba: nunca queda a medias.

### Probar una destination

El botón **Probar** hace un `GET` por el mismo camino que usaría el proxy
—autenticación, túnel, Connectivity Proxy— y dice **en qué etapa se corta**:

| Etapa | Qué significa |
|---|---|
| `resolve` | La destination no existe, o el Destination Service no la resuelve |
| `auth` | El tipo de autenticación falló (token no emitido, falta login…) |
| `route` | Es OnPremise y no hay Connectivity Proxy alcanzable |
| `connect` | No se llegó al backend (DNS, timeout, puerto cerrado) |
| `response` | El backend contestó: se muestra el status y los headers que explican un 401 |

Es solo lectura: no escribe en BTP ni en el backend. Ante un `401` con
`WWW-Authenticate`, la página explica el caso típico de PrincipalPropagation
(el Cloud Connector no envió el certificado del usuario).

### Endpoints propios

- `GET /` — la página de diagnóstico.
- `GET /__destinations` — lista completa con tipo de auth y proxy.
- `GET /__destination/<nombre>` — detalle resuelto (forma del Cloud SDK).
  Secretos enmascarados; `?reveal=1` los muestra.
- `GET /__health` — estado del proxy, target de CF, acceso on-premise y sesión de usuario.
- `GET /__login` — redirige al login de XSUAA. `GET /__logout` borra la sesión.
- `GET /__callback` — a donde vuelve XSUAA. No se llama a mano.
- `GET /__targets` — orgs y spaces accesibles, y el target actual.
- `POST /__target` — `{ org, space }`. Reapunta el CLI y rehace el descubrimiento.
- `GET /__test/<nombre>?path=/x` — prueba la destination (solo lectura).

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

`node server.js --profile <p> --list` te lo dice por destination, sin adivinar.

Verificado el 2026-09-04 en `bms-bld/BLD`: Basic on-prem
(`S4_BASIC_ZSB_WFTASK_UI2/$metadata`) devuelve `200` desde el S/4 por el
túnel. El proxy manda siempre el header `sap-client` de la destination: sin
él el ICM usa el mandante por default y el logon falla.

## 5. Los recursos propios (`mta.yaml`)

`cf-proxy cf <p> -- deploy mta_archives/cf-dest_1.0.0.mtar -f` despliega, una
vez por space, cuatro cosas con nombre fijo:

| Nombre | Qué es | Para qué |
|---|---|---|
| `cf-dest-xsuaa` | instancia `xsuaa` (plan `application`) | Login de usuario. Es la única pieza que **no** se puede reutilizar de otra app: sus `redirect-uris` apuntan a `http://localhost`. |
| `cf-dest-destination` | instancia `destination` (`lite`) | Listar y resolver destinations. |
| `cf-dest-connectivity` | instancia `connectivity` (`lite`) | Llegar al Cloud Connector. |
| `cf-dest-app` | app Node mínima, sin ruta, con SSH | Salto para el túnel. No sirve tráfico. |

Las tres instancias vienen con una service key `cf-dest-key`. Si `cf-proxy`
las encuentra, las usa directo y no revisa nada más del space.

Nada del subaccount se modifica: ni destinations, ni otras apps, ni sus XSUAA.
`cf-proxy cf <p> -- undeploy cf-dest --delete-services --delete-service-keys -f`
borra todo (app, instancias y keys).

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
- El `redirect_uri` es `http://localhost:<puerto del perfil>/__callback`. Si el
  puerto no está en las `redirect-uris` de [`xs-security.json`](xs-security.json),
  el paso 4 lo avisa y el login falla con `invalid_redirect`: hay que agregarlo
  y actualizar el XSUAA de **esa** subcuenta
  (`cf-proxy cf <p> -- update-service cf-dest-xsuaa -c xs-security.json`).

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

cf-proxy ──► localhost:<libre> ──ssh──► cf-dest-app ──► connectivityproxy:20003
                                                              │
                                                              ▼
                                                       Cloud Connector
                                                              │
                                                              ▼
                                                          S/4HANA
```

Si existe `cf-dest-app` (del deploy), el túnel se abre solo. Si no, con
`--tunnel` se busca cualquier app `STARTED` con SSH habilitado, o se indica
una con `--tunnel-app`. El puerto local es uno libre por corrida, así que
varios proxies pueden tener túnel a la vez. El túnel se cierra con el proxy
(`stop` mata el árbol completo, incluido el `cf ssh`).

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
| `Falta --profile` | Se corrió `server.js` sin perfil | `cf-proxy start <perfil>` |
| `El perfil X no tiene sesion de CF` | Primera vez, o el token de `cf` del perfil venció | `cf-proxy login <perfil>` |
| `El perfil X ya esta corriendo` | Ya hay una corrida de ese perfil | `cf-proxy ps` / `cf-proxy stop <perfil>` |
| `el puerto N lo usa Y` | Dos perfiles con el mismo puerto | `cf-proxy profiles edit <perfil> --port auto` |
| `Ninguna instancia de destination tiene una key usable` | Solo hay keys tipo `content` | Desplegar el MTA (§5) o `profiles edit <p> --create-keys` |
| `401 PrincipalPropagation necesita el JWT del usuario` | Sin sesión de usuario | Abrir `/__login` |
| `501 No hay un XSUAA propio` | No se hizo el deploy | Desplegar el MTA (§5) |
| `501 ... requiere el Connectivity Proxy` | Destination on-prem sin túnel | Desplegar el MTA (túnel automático) o `profiles edit <p> --tunnel` |
| `Ninguna app STARTED tiene SSH habilitado` | Sin `cf-dest-app` ni otra con SSH | Desplegar el MTA o `cf-proxy cf <p> -- enable-ssh <app>` + restart |
| Login vuelve con `invalid_redirect` | El puerto del perfil no está en `xs-security.json` | Agregarlo y `update-service` del XSUAA (§6) |
| `Insufficient scope for this resource` en una `OAuth2UserTokenExchange` | El JWT del login no trae `uaa.user` | `update-service` con el `xs-security.json` actual y volver a entrar por `/__login` |
| `403 Access denied to resource ... cloud connector` | El path no está expuesto en el CC | Revisar la URL: la destination ya incluye su base path |
| `401` del S/4 con `WWW-Authenticate: Basic` en una PP | El CC no propagó o el S/4 no mapeó | Ver §6, "Estado actual" |
| Página ICM "Anmeldung fehlgeschlagen" en una Basic | Mandante equivocado o credenciales vencidas | Ver `sap-client` en Detalles; probar el usuario de la destination |
| `404 La destination X no existe` | Nombre mal escrito | `GET /__destinations` |
| `400 CONFIRMACION REQUERIDA para ...` | Escritura sin `confirm` | Mandar `confirm` con el nombre exacto (la página lo hace al tipearlo) |
| `400 El body tiene que ser JSON` | Falta `content-type: application/json` | Agregar el header |
| Probar corta en `connect` | DNS/red o el backend no responde | Si es OnPremise, revisar el túnel en `/__health` |
| Probar corta en `auth` | El servicio no emitió token | El error trae el motivo real del token service |
