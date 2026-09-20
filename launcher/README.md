# cf-proxy launcher

Ventana para arrancar [cf-proxy](../) sin tocar la terminal, y
paquete listo para pasarle a un colega.

**No reemplaza nada del proxy.** Junta credenciales, org/space y opciones, y
ejecuta el mismo `node server.js` que se corre a mano. La línea de comandos
sigue funcionando igual.

## Para el que lo recibe

```
cf-proxy-launcher/
  cf-proxy.exe          ← doble clic
  LEEME.txt
  recursos/
    cf-proxy/           ← el proyecto Node
    cf-dest_1.0.0.mtar  ← pre-buildeado (no hace falta mbt)
```

Requisitos en la PC destino: **`cf` y `node` en el PATH**. El launcher los
verifica al arrancar y, si falta alguno, lo dice con el comando de `winget`
para instalarlo. No se incluyen a propósito: son herramientas que conviene
mantener actualizadas por fuera.

## Qué hace la ventana

1. **Requisitos** — `cf` y `node`. Si falta uno, no deja seguir.
2. **Cuenta** — perfil guardado, API endpoint, usuario, y login por
   contraseña o SSO. Si ya hay sesión de `cf` abierta, la aprovecha.
3. **Destino** — org y space se llenan con lo que el usuario realmente puede
   ver (API v3, igual que el proxy). Puerto (default 3100) y los flags
   (`--tunnel`, `--login`, `--create-keys`).
4. **Recursos** — si el space no tiene `cf-dest-destination`, ofrece
   desplegar el `.mtar` incluido. Sin `mbt` en la PC destino.
5. **Arranca** — lanza el proxy, muestra el log y abre la página.

## Dónde se guarda la configuración

`%APPDATA%\cf-proxy-launcher\`

| Archivo | Qué tiene |
|---|---|
| `profiles.json` | Perfiles: endpoint, usuario, org/space, puerto, flags. **Sin secretos.** |
| `secrets.bin` | Contraseñas, cifradas con **DPAPI** (la cuenta de Windows). |

La contraseña nunca se escribe en texto plano y el archivo cifrado **no sirve
en otra PC ni para otro usuario**: DPAPI ata la clave a la cuenta de Windows.
Se usa vía `ctypes`, sin dependencias externas.

## Desarrollo

```bash
python -m cfproxy_launcher     # correr desde el código
python build.py                # armar dist/cf-proxy-launcher/
```

`build.py` corre PyInstaller, copia el proyecto Node desde la raíz del repo
(solo lo que hace falta en runtime: sin `node_modules`, `.env` ni
`mta_archives`) y agrega el `.mtar` de `mta_archives/`; si no existe, corre
`mbt build`.

Para buildear hace falta `pyinstaller`. Para usarlo, no.

### Módulos

| Archivo | Responsabilidad |
|---|---|
| `store.py` | Perfiles (JSON) y contraseñas (DPAPI) |
| `cf.py` | Único que ejecuta `cf` y `node`. Devuelve datos normalizados |
| `paths.py` | Dónde está cada cosa, empaquetado o en el repo |
| `app.py` | La ventana (tkinter) |
| `run_launcher.py` | Entry point de PyInstaller (import absoluto) |

### Dos detalles que no son obvios

**`run_launcher.py` existe aparte de `__main__.py`** porque `python -m` corre
el módulo dentro del paquete (imports relativos OK) y PyInstaller lo corre
como script suelto (los mismos imports fallan).

**Al detener se mata el árbol de procesos**, no solo el hijo: `node server.js`
abre a su vez un `cf ssh` para el túnel on-premise, y matar solo al padre deja
ese `cf ssh` ocupando el puerto 20003. La limpieza corre también cuando el
proxy termina solo (por ejemplo si el puerto ya estaba ocupado), porque para
entonces el túnel ya pudo haberse abierto.
