---
name: verificar-target
description: Verificar el org/space de CF antes de escribir; un destino subaccount-level sobrevive al undeploy y hay que borrarlo por API
metadata:
  type: project
---

**El incidente (BMS, 2026-09-18).** Un `cf deploy` salio al org equivocado
(`BMS-BLD/BLD`, un cliente) porque el `cf target` apuntaba ahi. El MTA escribio
la destination `APPROVAL_HUB_API` en el subaccount de BMS, con el nombre
comercial de otro cliente adentro (`sap.cloud.service:
com.energytransfer.approvalhub`).

**Lo que costo descubrir:** `cf undeploy --delete-services` **no se la llevo**.
Un destino escrito con `content: subaccount:` vive en el **subaccount**, no
dentro de la instancia del Destination Service; la instancia es solo la
credencial de escritura. Borrar la instancia no vacia el subaccount.

**Como se resolvio:** con una service key de otra instancia de `destination`
del mismo space, `DELETE /destination-configuration/v1/subaccountDestinations/
APPROVAL_HUB_API`. Respondio `{"Count":1}` y el subaccount paso de 231 a 230
destinations.

**Why:** el error es facil de repetir (el target de CF es global y silencioso)
y el sintoma no aparece hasta que alguien mira el cockpit del cliente.

**Que cambio (2026-10-01):** cf-proxy ya no usa el `cf` global. Cada perfil
(una subcuenta) tiene su CF_HOME en `~/.cf-proxy/profiles/<p>/cf-home`, el org
queda fijo por perfil (la pagina solo cambia de space; otro org da 409) y el
deploy se hace con `node bin/cf-proxy.js cf <p> -- deploy ...`, que se niega a
apuntar a otro org. `npm run deploy/undeploy` (que usaban el `cf` global) se
sacaron a proposito.

**How to apply:**

- Deployar SIEMPRE por el wrapper del perfil (`cf-proxy cf <p> -- ...`), nunca
  con `cf` suelto. Mirar el banner `[cf-proxy] perfil X -> api / org / space`.
- Antes de escribir una destination, mirar el org/space. La pagina lo muestra
  en "Target CF" y `/__health` lo expone en `target` (y `profile`).
- Para revertir un deploy al lugar equivocado: `cf undeploy <mta>
  --delete-services` **y ademas** borrar a mano las destinations que el MTA
  escribio a nivel subaccount.
- Probar escrituras en la trial, nunca en un subaccount de cliente. Ver
  [[estado-y-trial]].
