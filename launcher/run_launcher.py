"""
Entry point para PyInstaller.

Hace falta aparte de `cfproxy_launcher/__main__.py` por como ejecuta cada uno:

  - `python -m cfproxy_launcher` corre __main__.py DENTRO del paquete, asi que
    los imports relativos (`from .app import main`) resuelven bien.
  - PyInstaller lo corre como script suelto, sin paquete padre, y esos mismos
    imports fallan con "attempted relative import with no known parent package".

Este archivo usa import absoluto, que funciona en los dos casos.
"""
from cfproxy_launcher.app import main

if __name__ == "__main__":
    main()
