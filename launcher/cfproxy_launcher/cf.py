"""
PASO 2 - Todo lo que se habla con el CLI de `cf` y con Node.

Mismo principio que lib/cf.js del proxy: este modulo es el unico que ejecuta
procesos externos, y devuelve datos ya normalizados.

Nada se hardcodea: orgs, spaces y el estado del login se preguntan al CLI.
"""
import json
import os
import re
import subprocess
from pathlib import Path

# Sin ventana de consola al ejecutar procesos (el launcher es una GUI).
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def _run(args: list, timeout: int = 60) -> tuple:
    """Ejecuta un comando y devuelve (ok, salida). Nunca lanza excepcion."""
    try:
        done = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout,
            creationflags=_NO_WINDOW, encoding="utf-8", errors="replace")
        return done.returncode == 0, (done.stdout or "") + (done.stderr or "")
    except FileNotFoundError:
        return False, f"No se encontro `{args[0]}` en el PATH."
    except subprocess.TimeoutExpired:
        return False, f"`{args[0]}` no respondio en {timeout}s."


# ---------------------------------------------------------------------------
# PASO 2a - Requisitos: cf y node tienen que estar instalados
# ---------------------------------------------------------------------------
def check_requirements() -> list:
    """
    Devuelve una lista de faltantes: [{tool, hint}]. Vacia = todo OK.

    Ninguno de los dos se incluye en el paquete a proposito: son herramientas
    que el usuario ya tiene o instala una vez, y que conviene mantener
    actualizadas por su cuenta.
    """
    missing = []

    ok, _ = _run(["cf", "--version"], timeout=20)
    if not ok:
        missing.append({
            "tool": "Cloud Foundry CLI (`cf`)",
            "hint": "Instalar desde https://github.com/cloudfoundry/cli/releases "
                    "o con:  winget install CloudFoundry.CloudFoundryCLI",
        })

    ok, _ = _run(["node", "--version"], timeout=20)
    if not ok:
        missing.append({
            "tool": "Node.js (`node`)",
            "hint": "cf-proxy corre sobre Node. Instalar desde https://nodejs.org "
                    "o con:  winget install OpenJS.NodeJS.LTS",
        })

    return missing


def versions() -> dict:
    """Versiones para mostrar en la barra de estado. '?' si no se pudo leer."""
    out = {}
    ok, text = _run(["cf", "--version"], timeout=20)
    m = re.search(r"version\s+(\S+)", text) if ok else None
    out["cf"] = m.group(1) if m else "?"
    ok, text = _run(["node", "--version"], timeout=20)
    out["node"] = text.strip() if ok else "?"
    return out


# ---------------------------------------------------------------------------
# PASO 2b - Sesion
# ---------------------------------------------------------------------------
def current_target() -> dict:
    """
    Lee `cf target`. Devuelve {logged, api, user, org, space}.

    `logged` es False si no hay sesion: el resto de los campos viene vacio.
    """
    ok, text = _run(["cf", "target"], timeout=30)
    if not ok:
        return {"logged": False, "api": "", "user": "", "org": "", "space": ""}

    def field(label):
        m = re.search(rf"^{label}:\s*(.+)$", text, re.I | re.M)
        return m.group(1).strip() if m else ""

    return {
        "logged": True,
        "api": field("API endpoint"),
        "user": field("user"),
        "org": field("org"),
        "space": field("space"),
    }


def login_password(api: str, user: str, password: str) -> tuple:
    """
    Login con usuario y contrasena. Devuelve (ok, mensaje).

    No sirve si el subaccount usa SSO corporativo: en ese caso el CLI responde
    que hay que usar `--sso`, y el mensaje se muestra tal cual.
    """
    ok, text = _run(["cf", "login", "-a", api, "-u", user, "-p", password], timeout=120)
    return ok, _last_lines(text)


def sso_url(api: str) -> tuple:
    """
    Prepara un login SSO: apunta el CLI al endpoint y devuelve la URL donde el
    usuario saca el passcode temporal. El passcode se pide en la ventana.
    """
    ok, text = _run(["cf", "api", api], timeout=60)
    if not ok:
        return False, _last_lines(text)
    # La URL del passcode se deriva del endpoint: api.cf.<region> -> login.cf.<region>
    return True, api.replace("://api.", "://login.").rstrip("/") + "/passcode"


def login_sso(api: str, passcode: str) -> tuple:
    """Login con el passcode temporal que el usuario copia del browser."""
    ok, text = _run(["cf", "login", "-a", api, "--sso-passcode", passcode], timeout=120)
    return ok, _last_lines(text)


def logout() -> None:
    _run(["cf", "logout"], timeout=30)


# ---------------------------------------------------------------------------
# PASO 2c - Orgs, spaces y target
# ---------------------------------------------------------------------------
def list_targets() -> list:
    """
    Orgs accesibles con sus spaces: [{org, spaces:[...]}].

    Se usa la API v3 via `cf curl` en vez de parsear las tablas de `cf orgs`,
    que tienen ancho variable. Mismo criterio que lib/cf.js del proxy.
    """
    orgs = _curl_all("/v3/organizations?per_page=100")
    if not orgs:
        return []

    names = {o["guid"]: o["name"] for o in orgs}
    by_org = {}
    for sp in _curl_all("/v3/spaces?per_page=100"):
        guid = (sp.get("relationships", {}).get("organization", {}).get("data") or {}).get("guid")
        if guid in names:
            by_org.setdefault(guid, []).append(sp["name"])

    return sorted(
        ({"org": names[g], "spaces": sorted(s)} for g, s in by_org.items()),
        key=lambda t: t["org"].lower())


def set_target(org: str, space: str) -> tuple:
    ok, text = _run(["cf", "target", "-o", org, "-s", space], timeout=60)
    return ok, _last_lines(text)


def has_destination_instance() -> bool:
    """
    True si el space actual tiene una instancia del servicio `destination`.

    Es lo minimo que cf-proxy necesita para arrancar; si falta, la ventana
    ofrece desplegar el MTA incluido en el paquete.
    """
    for inst in _curl_all("/v3/service_instances?per_page=100"):
        # El nombre del offering no viene en el recurso; alcanza con el propio
        # del MTA, que es lo que despliega el launcher.
        if inst.get("name") == "cf-dest-destination":
            return True
    return False


def deploy_mtar(mtar: Path, on_line) -> bool:
    """
    Despliega el .mtar incluido en el paquete.

    Se usa el .mtar ya buildeado a proposito: asi la PC destino no necesita
    `mbt`, solo el plugin multiapps del CLI (que viene con las versiones
    actuales de `cf`).
    """
    return stream(["cf", "deploy", str(mtar), "-f"], on_line, cwd=mtar.parent)


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------
# PIDs de los procesos lanzados, para poder cortarlos al detener o al cerrar.
_running = {}


def stream(args: list, on_line, cwd: Path = None, key: str = None) -> bool:
    """
    Ejecuta un comando enviando cada linea a `on_line` mientras corre.

    Se usa para el deploy y para el propio cf-proxy: el usuario ve el progreso
    en vez de una ventana congelada. Con `key` se registra el PID para poder
    matarlo despues con kill_tree.
    """
    try:
        proc = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            bufsize=1, creationflags=_NO_WINDOW, cwd=str(cwd) if cwd else None,
            encoding="utf-8", errors="replace")
    except FileNotFoundError:
        on_line(f"No se encontro `{args[0]}` en el PATH.")
        return False

    if key:
        _running[key] = proc.pid

    for line in proc.stdout:
        on_line(line.rstrip())
    proc.wait()

    if key:
        # Limpieza tambien cuando el proceso termina SOLO (p.ej. el puerto ya
        # estaba ocupado): para entonces pudo haber dejado un `cf ssh` del
        # tunel colgado de un nieto, que sobrevive a la muerte del padre.
        kill_tree(key)
    return proc.returncode == 0


def port_in_use(port: int) -> bool:
    """
    True si algo ya escucha en ese puerto local.

    Se chequea ANTES de arrancar: el proxy abre el tunel SSH antes de intentar
    el puerto, asi que un EADDRINUSE lo deja a medias y hay que limpiar. Avisar
    antes es mas barato que limpiar despues.
    """
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(1)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def kill_tree(key: str) -> None:
    """
    Corta un proceso lanzado con `stream` y TODOS sus hijos.

    El arbol importa: `node server.js` abre a su vez un `cf ssh` para el tunel
    on-premise. Matar solo al padre deja ese `cf ssh` huerfano ocupando el
    puerto local, y el arranque siguiente falla con un error poco claro.
    """
    pid = _running.pop(key, None)
    if not pid:
        return
    # /T incluye a los hijos; el proceso ya puede no existir y no importa.
    _run(["taskkill", "/PID", str(pid), "/T", "/F"], timeout=20)


def _curl_all(url: str) -> list:
    """GET paginado de la API v3: junta todos los `resources`."""
    out = []
    while url:
        ok, text = _run(["cf", "curl", url], timeout=60)
        if not ok or "{" not in text:
            break
        try:
            body = json.loads(text[text.index("{"):])
        except ValueError:
            break
        out.extend(body.get("resources", []))
        nxt = (body.get("pagination", {}).get("next") or {}).get("href")
        url = nxt[nxt.index("/v3/"):] if nxt else None
    return out


def _last_lines(text: str, count: int = 3) -> str:
    """Ultimas lineas utiles de la salida del CLI, que es donde va el motivo."""
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    return "\n".join(lines[-count:]) if lines else "Sin detalle."
