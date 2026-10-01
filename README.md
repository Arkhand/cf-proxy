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

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run launcher` | Abre la ventana (perfiles + una pestaña por proxy) desde el código |
| `npm start -- <perfil>` | Arranca el proxy de un perfil en segundo plano |
| `npm run ps` | Qué proxies corren, en qué puerto y con qué estado |
| `npm test` | Tests (servicios y `cf` falsos; no tocan BTP) |
| `npm run dist` | Arma el paquete para compartir (ver abajo) |
| `npm run build:mta` | Rearma `mta_archives/cf-dest_1.0.0.mtar` (hace falta `mbt`) |

## Armar el paquete para compartir

El paquete es una carpeta con `cf-proxy.exe` (la ventana), el proyecto Node y
el `.mtar` pre-armado. El que lo recibe solo necesita `cf` y `node`; la guía
para él va adentro (`LEEME.md`, fuente en [`launcher/LEEME.md`](launcher/LEEME.md)).

Una vez, en la PC que arma el paquete (Windows, Python 3):

```bash
pip install -r launcher/requirements-build.txt    # PyInstaller
```

Cada vez:

```bash
npm test          # que esté todo en verde
npm run dist      # = python launcher/build.py
```

Deja todo en **`launcher/dist/cf-proxy-launcher/`**: comprimir **esa carpeta
entera** y pasarla. `launcher/dist/` no se versiona.

- Si cambiaste `mta.yaml` o `xs-security.json`, corré antes `npm run build:mta`
  (necesita `mbt`): el paquete lleva el `.mtar` de `mta_archives/`, no lo arma.
- Si `cf-proxy.exe` está abierto, el build falla al pisarlo: cerralo antes.

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
