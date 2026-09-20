"""
Donde esta cada cosa, tanto corriendo desde el codigo como desde el .exe.

El paquete distribuible se ve asi:

    cf-proxy-launcher/
      cf-proxy.exe          <- este programa
      recursos/
        cf-proxy/           <- el proyecto Node, tal cual
        cf-dest_1.0.0.mtar  <- pre-buildeado: la PC destino no necesita mbt

Y en desarrollo, el repo:

    CF-proxy/               <- el proyecto (server.js en la raiz)
      launcher/             <- este codigo

Se buscan las dos formas para que `python -m cfproxy_launcher` y el .exe se
comporten igual.
"""
import sys
from pathlib import Path


def base_dir() -> Path:
    """Carpeta del ejecutable (o la raiz del repo, en desarrollo)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    # cfproxy_launcher/ -> launcher/ -> raiz del repo
    return Path(__file__).resolve().parents[2]


def find_proxy_dir():
    """
    Carpeta del proyecto Node: la que tiene server.js.

    Empaquetado esta en recursos/cf-proxy/; en desarrollo es la raiz del repo.
    """
    base = base_dir()
    for path in (base / "recursos" / "cf-proxy", base):
        if (path / "server.js").is_file():
            return path
    return None


def find_mtar():
    """El .mtar pre-buildeado para desplegar los recursos. None si no esta."""
    for folder in [base_dir() / "recursos", base_dir(), base_dir() / "mta_archives"]:
        if folder.is_dir():
            found = sorted(folder.glob("*.mtar"))
            if found:
                return found[0]
    return None
