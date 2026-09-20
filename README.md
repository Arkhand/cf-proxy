# cf-proxy

Proxy local hacia las **destinations de un subaccount de SAP BTP**, usando los
servicios de Cloud Foundry. Sin BAS, sin cookies que caducan, sin configuración
previa: org, space, instancias y destinations se descubren en runtime.

```
node server.js            # o doble clic en cf-proxy.exe (ver launcher/)
```

Levanta `http://localhost:3100` con una página donde podés **ver, probar,
crear, editar y eliminar** las destinations del subaccount, y que además
proxya los requests hacia ellas aplicando su autenticación:

```
http://localhost:3100/<NOMBRE_DESTINATION>/<path>
```

## Estructura

| Carpeta | Qué es |
|---|---|
| `server.js`, `lib/` | El proxy: descubrimiento, credenciales, túnel, ruteo |
| `webapp/` | La página (UI5, un solo HTML, sin build) |
| `test/` | 104 tests contra servicios falsos; no tocan BTP |
| `mta.yaml`, `xs-security.json` | Los recursos propios (`cf-dest-*`) |
| [`launcher/`](launcher/) | Ventana de Windows + paquete para compartir |

La documentación completa está en [README-cf-proxy.md](README-cf-proxy.md):
qué destinations funcionan, cómo se resuelve cada tipo de autenticación,
PrincipalPropagation, el túnel on-premise y los endpoints propios.
