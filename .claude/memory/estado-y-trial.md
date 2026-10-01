---
name: estado-y-trial
description: Que esta hecho en cf-proxy, la trial donde se prueba escritura, y lo que el Destination Service real hace distinto de lo documentado
metadata:
  type: project
---

**Estado (2026-09-20).** El repo es solo cf-proxy: `server.js` y `lib/` en la
raiz, el launcher de Windows en `launcher/`. Se separo de BAS-PROXY (que
contiene `bas-gateway` y `bas-proxy`, otro enfoque: reusan la cookie de BAS).

Hecho y verificado contra la trial:

- Leer, crear, editar y eliminar destinations desde la pagina UI5, con
  formulario por tipo de auth, preview del diff, aviso explicito y
  confirmacion tipeando el nombre exacto.
- Cambiar de org/space desde la pagina sin reiniciar (`POST /__target`).
- Probar una destination (`GET /__test/<nombre>`): un GET real por el camino
  del proxy que dice en que etapa se corta.
- Launcher en Python/tkinter que empaqueta a un .exe de ~10 MB con el proyecto
  Node y el .mtar pre-buildeado al lado.

`npm test` corre 6 suites contra servicios y un `cf` falsos (sin tocar BTP).

**Multi-instancia (2026-10-01):** perfiles por subcuenta (`lib/profiles.js`),
CF_HOME por perfil, registro/lock de corridas (`lib/runs.js`), consola
`bin/cf-proxy.js` (profiles/login/targets/start/stop/ps/logs/cf) y launcher con
una pestana por corrida. Verificado contra etp-shared-lab: login en el CF_HOME
del perfil, start en segundo plano, tunel en puerto libre, 409 al cambiar de
org, stop sin `cf ssh` huerfano, y `~/.cf/config.json` sin cambios.
Pendiente: redirect-uris de XSUAA para puertos != 3100 (ver README §6); hasta
actualizar el `cf-dest-xsuaa` de cada subcuenta, el login de usuario solo anda
en el perfil que tenga el 3100.

**Pendiente principal: PrincipalPropagation.** Llega al S/4 y recibe 401 con
`WWW-Authenticate: Basic`, o sea el Cloud Connector no envio el certificado
del usuario. El README tiene el diagnostico completo; lo que falta es
configuracion del CC de BMS (sospecha principal: Principal Type en `None`),
no codigo.

**Trial de prueba:** org `5e80c1b2trial` / space `dev`, api `us10-001`. Tiene
desplegado el MTA `cf-dest` completo. Para probar: un perfil a esa trial,
`cf-proxy login <p>` y `cf-proxy start <p>`. Para dejarla limpia:
`cf-proxy cf <p> -- undeploy cf-dest --delete-services --delete-service-keys -f`.
Ojo: el perfil importado `Trial` apunta a BMS-BLD/BLD en us10-001, que no es
la trial; hay que corregirlo antes de usarlo.

**Hallazgos del servicio real, no derivables del codigo:**

- `cf-dest-destination` / `cf-dest-key` (client_credentials, **sin scopes
  extra**) alcanza para leer, crear, actualizar y borrar destinations del
  subaccount. No hace falta tocar `xs-security.json`.
- Las escrituras responden **207** con el status real adentro del body
  (`[{name, status:"409", cause}]`), no 409 al tope. `write()` en
  `lib/destinations.js` lo desenvuelve.
- El servicio **acepta tipos de `Authentication` que no existen** (no valida
  contra una lista): por eso el combo de la pagina admite texto libre.
- El JSON de una destination trae `URL` y `url` a la vez. PowerShell 5.1 no
  puede parsearlo (`ConvertFrom-Json` falla con claves duplicadas); Node y
  Python si.
- El catalogo de campos por tipo de auth (`AUTH_TYPES` en webapp/index.html)
  se verifico contra `SAP-docs/btp-connectivity` en GitHub, no contra
  help.sap.com: esa pagina se renderiza por JavaScript y no se puede leer con
  un fetch simple.

Ver [[verificar-target]] antes de cualquier escritura.

**Sesiones y contraseñas compartidas con cf-target (2026-10-01).** `lib/sessions.js` y
`lib/targetfile.js` son copias exactas de `../cf-target/lib/` (el test
`cf-target/test/vendored.test.js` avisa si se desfasan: editar allá y copiar). La sesión
de cf es por (api, usuario) en `~/.cf-target/sessions/`; cada comando y cada proxy usa
una copia privada. `profiles.load()` migra solas las sesiones viejas de
`~/.cf-proxy/profiles/<p>/cf-home`. El launcher guarda contraseñas en el Credential
Manager (`cf-target:<api>:<usuario>`) y migra `secrets.bin` al abrirse.
