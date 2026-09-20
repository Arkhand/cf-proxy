---
name: naming-cf-resources
description: Los recursos que la herramienta crea en CF se llaman cf-dest-*, sin "proxy" ni "tunnel" en el nombre
metadata:
  type: feedback
---

Los recursos que cf-proxy despliega en Cloud Foundry se llaman
`cf-dest-xsuaa`, `cf-dest-destination`, `cf-dest-connectivity`, la app
`cf-dest-app` y la key `cf-dest-key` (MTA ID `cf-dest`). El usuario rechazo dos
veces nombres como `cf-proxy-tunnel` / `dest-tunnel`. El `mta.yaml` y
`xs-security.json` viven en la raiz del repo, no en una subcarpeta `deploy/`.

**Why:** quiere nombres que no delaten el proposito en un space compartido con
el cliente, y que el programa los use directo por nombre exacto si existen
(sin buscar).

**How to apply:** al agregar recursos nuevos seguir el prefijo `cf-dest-` con
un sufijo neutro; nunca "proxy"/"tunnel"/"ssh" en el nombre. Los nombres
propios estan en `OWN` (lib/discover.js) y son la unica convencion de la
herramienta: todo lo demas se descubre. Ver [[code-style-steps]].
