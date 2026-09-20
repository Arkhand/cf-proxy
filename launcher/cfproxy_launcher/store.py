"""
PASO 1 - Perfiles y contrasenas.

Dos almacenamientos separados a proposito:

  - Los PERFILES (api endpoint, usuario, org, space, puerto, flags) van en un
    JSON legible en %APPDATA%. No son secretos y conviene poder mirarlos.

  - Las CONTRASENAS se cifran con la DPAPI de Windows (CryptProtectData), la
    misma que usa Credential Manager por debajo. El cifrado queda atado a la
    cuenta de Windows: el archivo no sirve en otra PC ni para otro usuario.
    Se usa por ctypes para no agregar dependencias al build.

La contrasena NUNCA se escribe en el JSON ni se pasa por linea de comandos de
forma que quede en el historial: va como argumento a `cf login`, que es la
unica manera que el CLI acepta.
"""
import ctypes
import ctypes.wintypes
import json
import os
from pathlib import Path

APP_DIR = Path(os.environ.get("APPDATA", Path.home())) / "cf-proxy-launcher"
PROFILES_FILE = APP_DIR / "profiles.json"
SECRETS_FILE = APP_DIR / "secrets.bin"


# ---------------------------------------------------------------------------
# DPAPI: cifrado atado al usuario de Windows
# ---------------------------------------------------------------------------
class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob_in(data: bytes) -> _Blob:
    buf = ctypes.create_string_buffer(data, len(data))
    return _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))


def _blob_out(blob: _Blob) -> bytes:
    out = ctypes.string_at(blob.pbData, blob.cbData)
    ctypes.windll.kernel32.LocalFree(blob.pbData)
    return out


def _protect(data: bytes) -> bytes:
    """Cifra con la clave del usuario actual de Windows."""
    out = _Blob()
    ok = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(_blob_in(data)), "cf-proxy-launcher", None, None, None, 0, ctypes.byref(out))
    if not ok:
        raise OSError("CryptProtectData fallo")
    return _blob_out(out)


def _unprotect(data: bytes) -> bytes:
    """Descifra. Falla si el archivo vino de otra PC o de otro usuario."""
    out = _Blob()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(_blob_in(data)), None, None, None, None, 0, ctypes.byref(out))
    if not ok:
        raise OSError("CryptUnprotectData fallo")
    return _blob_out(out)


# ---------------------------------------------------------------------------
# Perfiles (JSON plano, sin secretos)
# ---------------------------------------------------------------------------
DEFAULT_PROFILE = {
    "name": "",
    "api": "https://api.cf.us10.hana.ondemand.com",
    "user": "",
    "auth": "password",   # "password" | "sso"
    "org": "",
    "space": "",
    "port": 3100,
    "tunnel": False,
    "login": False,
    "create_keys": False,
    "open_browser": True,
}


def load_profiles() -> list:
    """Lista de perfiles guardados. Devuelve [] si no hay nada todavia."""
    try:
        data = json.loads(PROFILES_FILE.read_text(encoding="utf-8"))
        return [{**DEFAULT_PROFILE, **p} for p in data.get("profiles", [])]
    except (OSError, ValueError):
        return []


def save_profiles(profiles: list) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    PROFILES_FILE.write_text(
        json.dumps({"profiles": profiles}, indent=2, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------------------
# Contrasenas (cifradas, una por perfil)
# ---------------------------------------------------------------------------
def _load_secrets() -> dict:
    try:
        return json.loads(_unprotect(SECRETS_FILE.read_bytes()).decode("utf-8"))
    except (OSError, ValueError):
        # Archivo ausente, corrupto, o de otro usuario: se empieza de cero.
        return {}


def _save_secrets(secrets: dict) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    SECRETS_FILE.write_bytes(_protect(json.dumps(secrets).encode("utf-8")))


def get_password(profile_name: str) -> str:
    return _load_secrets().get(profile_name, "")


def set_password(profile_name: str, password: str) -> None:
    """Guarda (o borra, si `password` es vacio) la contrasena de un perfil."""
    secrets = _load_secrets()
    if password:
        secrets[profile_name] = password
    else:
        secrets.pop(profile_name, None)
    _save_secrets(secrets)


def forget_profile(profile_name: str) -> None:
    """Saca el perfil y su contrasena."""
    save_profiles([p for p in load_profiles() if p["name"] != profile_name])
    set_password(profile_name, "")
