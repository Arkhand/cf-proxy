# cf-proxy

Proxy local hacia las **destinations de un subaccount de SAP BTP**, usando los
servicios de Cloud Foundry. Sin BAS, sin cookies que caducan, sin configuración
previa: org, space, instancias y destinations se descubren en runtime.

```
node bin/cf-proxy.js start <perfil>   # o doble clic en cf-proxy.exe (ver launcher/)
```

Cada corrida sale de un **perfil** guardado: una subcuenta de cliente, con su
puerto y su propia sesión de `cf` (nunca la global). Se pueden tener varios
clientes corriendo a la vez, y cualquier terminal (o una IA en otro chat) ve
qué está corriendo con `node bin/cf-proxy.js ps`.

Levanta `http://localhost:<puerto>` con una página donde podés **ver, probar,
crear, editar y eliminar** las destinations del subaccount, y que además
proxya los requests hacia ellas aplicando su autenticación:

```
http://localhost:3100/<NOMBRE_DESTINATION>/<path>
```

## Estructura

| Carpeta | Qué es |
|---|---|
| `server.js`, `lib/` | El proxy: perfiles, descubrimiento, credenciales, túnel, ruteo |
| `bin/cf-proxy.js` | La consola: perfiles, login, start/stop/ps/logs y `cf` con la sesión del perfil |
| `webapp/` | La página (UI5, un solo HTML, sin build) |
| `test/` | Tests contra servicios y un `cf` falsos; no tocan BTP |
| `mta.yaml`, `xs-security.json` | Los recursos propios (`cf-dest-*`) |
| [`launcher/`](launcher/) | Ventana de Windows + paquete para compartir |

La documentación completa está en [README-cf-proxy.md](README-cf-proxy.md):
qué destinations funcionan, cómo se resuelve cada tipo de autenticación,
PrincipalPropagation, el túnel on-premise y los endpoints propios.
