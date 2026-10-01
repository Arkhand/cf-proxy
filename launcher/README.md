# cf-proxy launcher

Consola de administración y lanzamiento de [cf-proxy](../), y paquete listo
para pasarle a un colega.

**No reemplaza nada del proxy.** Todo lo que hace pasa por la consola
`node bin/cf-proxy.js ... --json`: la misma que se usa desde una terminal o
desde una IA. Por eso la ventana muestra también los proxies que se lanzaron
por consola, y la consola ve los que lanzó la ventana.

## Para el que lo recibe

```
cf-proxy-launcher/
  cf-proxy.exe          ← doble clic
  LEEME.md              ← guía de uso (fuente: launcher/LEEME.md)
  recursos/
    cf-proxy/           ← el proyecto Node
    cf-dest_1.0.0.mtar  ← pre-buildeado (no hace falta mbt)
```

Requisitos en la PC destino: **`cf` y `node` en el PATH**. El launcher los
verifica al arrancar y, si falta alguno, lo dice con el comando de `winget`
para instalarlo. No se incluyen a propósito: son herramientas que conviene
mantener actualizadas por fuera.

La guía completa para el que recibe el paquete está en [LEEME.md](LEEME.md):
perfiles, arranque, login de usuario, consola y problemas frecuentes.

## Qué hace la ventana

1. **Requisitos** — `cf` y `node`. Si falta uno, no deja seguir.
2. **Perfiles** (arriba) — uno por subcuenta de cliente, cada uno con su
   puerto. Alta: datos de la cuenta → *Conectar y listar orgs* (loguea con la
   sesión **propia del perfil**, nunca la global de `cf`) → elegir org/space →
   *Guardar*. Los perfiles con problemas (puerto repetido, sin org) se ven en
   rojo y no arrancan.
3. **Iniciar** — `cf-proxy start <perfil>`. Si el perfil no tiene sesión, pide
   login y reintenta. Si el space no tiene `cf-dest-destination`, ofrece
   desplegar el `.mtar` incluido **con la sesión del perfil**. Sin `mbt` en la
   PC destino.
4. **Pestañas** (abajo) — una por proxy corriendo, de cualquier origen: estado
   (health), usuario, org/space, puerto, de dónde se lanzó y el log en vivo.
   *Abrir página*, *Detener*, *Cerrar pestaña* (detiene y la saca). Se
   actualizan solas cada 3 s con `cf-proxy ps`.
5. **Al cerrar** — pregunta solo por los proxies que lanzó esta ventana: Sí
   (detenerlos), No (dejarlos corriendo), Cancelar. Los lanzados por consola
   no se tocan.

## Dónde se guarda la configuración

| Dónde | Qué tiene |
|---|---|
| `~/.cf-proxy/profiles.json` | Perfiles: endpoint, usuario, org/space, puerto, flags. **Sin secretos.** Compartidos con la consola. |
| `~/.cf-proxy/profiles/<p>/cf-home` | La sesión de `cf` de cada perfil. |
| `~/.cf-proxy/runs/` | Proxies corriendo (`<p>.json`) y su salida (`<p>.log`). |
| `%APPDATA%\cf-proxy-launcher\secrets.bin` | Contraseñas por perfil, cifradas con **DPAPI** (la cuenta de Windows). |

La primera vez que corre, la consola importa los perfiles del launcher viejo
(`%APPDATA%\cf-proxy-launcher\profiles.json`). Los que choquen en puerto
quedan marcados hasta corregirlos.

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
| `store.py` | Contraseñas por perfil (DPAPI) |
| `cf.py` | Requisitos: `cf` y `node` instalados |
| `cli.py` | Todo lo demás: llama a `node bin/cf-proxy.js ... --json` |
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
