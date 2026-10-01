"""
PASO 1 - Requisitos: `cf` y `node` instalados.

Es lo unico que la ventana pregunta directo a los CLIs. Todo lo demas (login,
target, arrancar, detener) pasa por la consola de cf-proxy (cli.py), que
corre cada `cf` con el CF_HOME del perfil y nunca con la sesion global.
"""
import os
import re
import subprocess

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
