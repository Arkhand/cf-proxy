"""
Punto de entrada.

    python -m cfproxy_launcher     en desarrollo
    cf-proxy.exe                   ya empaquetado
"""
from .app import main

if __name__ == "__main__":
    main()
