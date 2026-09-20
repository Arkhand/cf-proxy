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

`npm test` son 104 tests contra servicios falsos (sin tocar BTP).

**Pendiente principal: PrincipalPropagation.** Llega al S/4 y recibe 401 con
`WWW-Authenticate: Basic`, o sea el Cloud Connector no envio el certificado
del usuario. El README tiene el diagnostico completo; lo que falta es
configuracion del CC de BMS (sospecha principal: Principal Type en `None`),
no codigo.

**Trial de prueba:** org `5e80c1b2trial` / space `dev`, api `us10-001`. Tiene
desplegado el MTA `cf-dest` completo. Para probar: `cf login` a esa trial y
`node server.js`. Para dejarla limpia: `npm run undeploy`.

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
