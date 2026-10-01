"""
Arma el paquete distribuible.

    python build.py

Deja en dist/ una carpeta lista para comprimir y pasar:

    cf-proxy-launcher/
      cf-proxy.exe          <- doble clic
      LEEME.md              <- guia de uso para el que lo recibe
      recursos/
        cf-proxy/           <- el proyecto Node (sin node_modules: no tiene)
        cf-dest_1.0.0.mtar  <- pre-buildeado, para no exigir mbt en destino

Requisitos para BUILDEAR (no para usar): pyinstaller. El .mtar se toma de
cf-proxy/mta_archives/; si no esta, se corre `mbt build`.
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# El proyecto Node es la raiz del repo; el launcher vive en launcher/.
PROXY = ROOT.parent
DIST = ROOT / "dist" / "cf-proxy-launcher"

# Lo que el proxy necesita en runtime. Se listan a mano para no arrastrar
# mta_archives, .env, node_modules ni el historial de git.
# xs-security.json: el proxy lo lee para avisar si el puerto del perfil no
# esta en las redirect-uris del XSUAA.
PROXY_FILES = ["server.js", "package.json", "README.md", "xs-security.json"]
PROXY_DIRS = ["bin", "lib", "webapp"]

# La guia para el que recibe el paquete. Se edita en launcher/LEEME.md.
LEEME = ROOT / "LEEME.md"


def run(args, cwd=None):
    print(">", " ".join(str(a) for a in args))
    return subprocess.run(args, cwd=str(cwd) if cwd else None).returncode == 0


def find_mtar():
    """El .mtar ya buildeado; si no existe, se pide a mbt."""
    archives = PROXY / "mta_archives"
    found = sorted(archives.glob("*.mtar")) if archives.is_dir() else []
    if found:
        return found[0]

    print("No hay .mtar; corriendo mbt build...")
    if not run(["mbt", "build", "-t", "mta_archives"], cwd=PROXY):
        return None
    found = sorted(archives.glob("*.mtar"))
    return found[0] if found else None


def main():
    if DIST.exists():
        shutil.rmtree(DIST)
    recursos = DIST / "recursos"
    (recursos / "cf-proxy").mkdir(parents=True)

    # 1. El .exe
    print("\n== PyInstaller ==")
    ok = run([
        sys.executable, "-m", "PyInstaller",
        "--onefile", "--windowed", "--name", "cf-proxy",
        "--distpath", str(DIST),
        "--workpath", str(ROOT / "build"),
        "--specpath", str(ROOT / "build"),
        "run_launcher.py",
    ], cwd=ROOT)
    if not ok:
        print("Fallo PyInstaller.")
        return 1

    # 2. El proyecto Node
    print("\n== Copiando cf-proxy ==")
    for name in PROXY_FILES:
        shutil.copy2(PROXY / name, recursos / "cf-proxy" / name)
    for name in PROXY_DIRS:
        shutil.copytree(PROXY / name, recursos / "cf-proxy" / name)
    print(f"  {len(PROXY_FILES)} archivos + {len(PROXY_DIRS)} carpetas")

    # 3. El .mtar pre-buildeado
    print("\n== .mtar ==")
    mtar = find_mtar()
    if mtar:
        shutil.copy2(mtar, recursos / mtar.name)
        print(f"  {mtar.name}")
    else:
        print("  AVISO: sin .mtar. El launcher no va a poder desplegar recursos.")

    shutil.copy2(LEEME, DIST / "LEEME.md")

    size = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file())
    print(f"\nListo: {DIST}  ({size / 1024 / 1024:.1f} MB)")
    print("Comprimir esa carpeta y pasarla.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
