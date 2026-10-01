"""
PASO 2 - Todo lo que la ventana le pide a cf-proxy pasa por su consola.

La ventana NO ejecuta `cf` ni lee los perfiles o el registro de corridas por
su cuenta: llama a `node bin/cf-proxy.js ... --json`, que es el mismo
programa que se usa desde una terminal o desde una IA. Asi hay una sola
implementacion del lock, del CF_HOME por perfil y del health, y lo que la
ventana muestra es exactamente lo que vera `cf-proxy ps` en otra terminal.

Lo unico que se lee directo es el archivo de log de cada corrida (su ruta
viene en `ps`): hacerle tail es trivial y no vale un proceso por segundo.
"""
import json
import os
import subprocess
from pathlib import Path

# Sin ventana de consola al ejecutar procesos (el launcher es una GUI).
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

# Codigos de salida de la consola (lib/runs.js EXIT).
NO_SESSION = 4
NO_RESOURCES = 6


class Cli:
    def __init__(self, proxy_dir: Path):
        self.proxy_dir = proxy_dir
        self.script = str(proxy_dir / "bin" / "cf-proxy.js")

    def call(self, args: list, stdin: str = None, timeout: int = 90) -> dict:
        """
        Ejecuta un comando con --json y devuelve el objeto que imprime.
        Nunca lanza: un fallo vuelve como {ok: False, error}.
        """
        try:
            done = subprocess.run(
                ["node", self.script, *args, "--json"], input=stdin, capture_output=True,
                text=True, timeout=timeout, creationflags=_NO_WINDOW, cwd=str(self.proxy_dir),
                encoding="utf-8", errors="replace")
        except FileNotFoundError:
            return {"ok": False, "error": "No se encontro `node` en el PATH."}
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"cf-proxy {args[0]} no respondio en {timeout}s."}

        lines = [ln for ln in (done.stdout or "").splitlines() if ln.strip()]
        try:
            return json.loads(lines[-1])
        except (IndexError, ValueError):
            detail = ((done.stderr or "") + (done.stdout or "")).strip()
            return {"ok": False, "code": done.returncode, "error": detail[-500:] or "Sin detalle."}

    # --- Perfiles -------------------------------------------------------------
    def profiles(self) -> dict:
        return self.call(["profiles", "list"])

    def save_profile(self, profile: dict) -> dict:
        return self.call(["profiles", "save"], stdin=json.dumps(profile))

    def remove_profile(self, name: str) -> dict:
        return self.call(["profiles", "remove", name])

    # --- Sesion de cf del perfil ------------------------------------------------
    def login_password(self, name: str, password: str) -> dict:
        """La contrasena va por stdin: no queda en la linea de comandos."""
        return self.call(["login", name, "--password-stdin"], stdin=password + "\n", timeout=180)

    def login_sso(self, name: str, passcode: str) -> dict:
        return self.call(["login", name, "--sso-passcode", passcode], timeout=180)

    def targets(self, name: str) -> dict:
        return self.call(["targets", name], timeout=120)

    # --- Corridas -------------------------------------------------------------
    def start(self, name: str) -> dict:
        # --no-open: la ventana abre la pagina por su cuenta si el perfil lo pide.
        return self.call(["start", name, "--origin", "ui", "--no-open"], timeout=240)

    def stop(self, name: str) -> dict:
        return self.call(["stop", name])

    def ps(self) -> dict:
        return self.call(["ps"], timeout=30)

    def run_cf(self, name: str, cf_args: list, on_line) -> bool:
        """
        `cf` con la sesion del perfil (p.ej. el deploy del .mtar), mostrando
        cada linea mientras corre. El wrapper exige que el org sea el del perfil.
        """
        try:
            proc = subprocess.Popen(
                ["node", self.script, "cf", name, "--", *cf_args], stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, bufsize=1, creationflags=_NO_WINDOW,
                cwd=str(self.proxy_dir), encoding="utf-8", errors="replace")
        except FileNotFoundError:
            on_line("No se encontro `node` en el PATH.")
            return False
        for line in proc.stdout:
            on_line(line.rstrip())
        proc.wait()
        return proc.returncode == 0


def sso_passcode_url(api: str) -> str:
    """La URL del passcode se deriva del endpoint: api.cf.<region> -> login.cf.<region>."""
    return api.replace("://api.", "://login.").rstrip("/") + "/passcode"
