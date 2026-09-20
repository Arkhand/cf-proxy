"""
Donde esta cada cosa, tanto corriendo desde el codigo como desde el .exe.

El paquete distribuible se ve asi:

    cf-proxy-launcher/
      cf-proxy.exe          <- este programa
      recursos/
        cf-proxy/           <- el proyecto Node, tal cual
        cf-dest_1.0.0.mtar  <- pre-buildeado: la PC destino no necesita mbt

Y en desarrollo, el repo:

    BAS-PROXY/
      cf-proxy/             <- el proyecto
      launcher/             <- este codigo

Se buscan las dos formas para que `python -m cfproxy_launcher` y el .exe se
comporten igual.
"""
import sys
from pathlib import Path


def base_dir() -> Path:
    """Carpeta del ejecutable (o del repo, en desarrollo)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parents[2]


def _candidates(*parts) -> list:
    base = base_dir()
    return [
        base / "recursos" / Path(*parts),   # paquete distribuido
        base / Path(*parts),                # repo en desarrollo
    ]


def find_proxy_dir():
    """Carpeta de cf-proxy: la que tiene server.js. None si no esta."""
    for path in _candidates("cf-proxy"):
        if (path / "server.js").is_file():
            return path
    return None


def find_mtar():
    """El .mtar pre-buildeado para desplegar los recursos. None si no esta."""
    for folder in [base_dir() / "recursos", base_dir(), base_dir() / "cf-proxy" / "mta_archives"]:
        if folder.is_dir():
            found = sorted(folder.glob("*.mtar"))
            if found:
                return found[0]
    return None
