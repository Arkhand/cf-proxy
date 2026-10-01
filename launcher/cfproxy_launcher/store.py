"""
PASO 1 - Contrasenas guardadas, en el Administrador de credenciales de Windows.

Una por (API endpoint, usuario), con la misma clave que usa cf-target
(`cf-target:<api>:<usuario>`): la contrasena que se guarda aca sirve para los
deploys de cualquier proyecto con ese usuario, y al reves. Se ve y se borra en
Panel de control > Administrador de credenciales > Credenciales de Windows.

Se usa advapi32 por ctypes para no agregar dependencias al build. La
contrasena nunca va a un archivo ni a una linea de comandos.

Antes las contrasenas iban en secrets.bin (DPAPI) con clave = nombre de
perfil; migrate_legacy() las pasa una sola vez.
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
from pathlib import Path

APP_DIR = Path(os.environ.get("APPDATA", Path.home())) / "cf-proxy-launcher"
LEGACY_FILE = APP_DIR / "secrets.bin"

CRED_TYPE_GENERIC = 1
CRED_PERSIST_LOCAL_MACHINE = 2


class _CREDENTIAL(ctypes.Structure):
    _fields_ = [("Flags", wt.DWORD), ("Type", wt.DWORD), ("TargetName", wt.LPWSTR),
                ("Comment", wt.LPWSTR), ("LastWritten", wt.FILETIME),
                ("CredentialBlobSize", wt.DWORD), ("CredentialBlob", ctypes.POINTER(ctypes.c_char)),
                ("Persist", wt.DWORD), ("AttributeCount", wt.DWORD), ("Attributes", ctypes.c_void_p),
                ("TargetAlias", wt.LPWSTR), ("UserName", wt.LPWSTR)]


_advapi = ctypes.WinDLL("advapi32", use_last_error=True)
_advapi.CredReadW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.POINTER(ctypes.POINTER(_CREDENTIAL))]
_advapi.CredReadW.restype = wt.BOOL
_advapi.CredWriteW.argtypes = [ctypes.POINTER(_CREDENTIAL), wt.DWORD]
_advapi.CredWriteW.restype = wt.BOOL
_advapi.CredDeleteW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD]
_advapi.CredDeleteW.restype = wt.BOOL
_advapi.CredFree.argtypes = [ctypes.c_void_p]


def _normalize_api(api: str) -> str:
    return str(api or "").strip().rstrip("/").lower()


def cred_key(api: str, user: str) -> str:
    return f"cf-target:{_normalize_api(api)}:{str(user or '').strip().lower()}"


def get_password(api: str, user: str) -> str:
    """La contrasena guardada, o '' si no hay."""
    pcred = ctypes.POINTER(_CREDENTIAL)()
    if not _advapi.CredReadW(cred_key(api, user), CRED_TYPE_GENERIC, 0, ctypes.byref(pcred)):
        return ""
    try:
        c = pcred.contents
        return ctypes.string_at(c.CredentialBlob, c.CredentialBlobSize).decode("utf-16-le")
    finally:
        _advapi.CredFree(pcred)


def set_password(api: str, user: str, secret: str) -> None:
    """Guarda la contrasena; con secret vacio la borra."""
    key = cred_key(api, user)
    if not secret:
        _advapi.CredDeleteW(key, CRED_TYPE_GENERIC, 0)
        return
    blob = secret.encode("utf-16-le")
    buf = ctypes.create_string_buffer(blob, len(blob))
    cred = _CREDENTIAL(Type=CRED_TYPE_GENERIC, TargetName=key, UserName=str(user).strip(),
                       CredentialBlobSize=len(blob), CredentialBlob=ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)),
                       Persist=CRED_PERSIST_LOCAL_MACHINE)
    if not _advapi.CredWriteW(ctypes.byref(cred), 0):
        raise OSError(f"CredWrite fallo ({ctypes.get_last_error()})")


# ---------------------------------------------------------------------------
# Migracion desde secrets.bin (DPAPI, clave = nombre de perfil)
# ---------------------------------------------------------------------------
class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _unprotect(data: bytes) -> bytes:
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    out = _Blob()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(out)):
        raise OSError("CryptUnprotectData fallo")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


def migrate_legacy(profiles: list) -> int:
    """
    Pasa las contrasenas de secrets.bin al Administrador de credenciales, usando
    el api y el usuario de cada perfil. Solo una vez: despues renombra el archivo.
    No pisa una contrasena que ya este en el Administrador.
    """
    if not LEGACY_FILE.exists():
        return 0
    try:
        legacy = json.loads(_unprotect(LEGACY_FILE.read_bytes()).decode("utf-8"))
    except (OSError, ValueError):
        return 0
    moved = 0
    for p in profiles:
        secret = legacy.get(p.get("name"))
        if secret and p.get("api") and p.get("user") and not get_password(p["api"], p["user"]):
            set_password(p["api"], p["user"], secret)
            moved += 1
    LEGACY_FILE.rename(LEGACY_FILE.with_name("secrets.bin.migrated"))
    return moved
