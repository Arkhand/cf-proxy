---
name: code-style-steps
description: El usuario quiere codigo en pasos bien separados y comentados, sin nada hardcodeado del subaccount actual
metadata:
  type: feedback
---

Cuando se escribe una herramienta nueva en este proyecto, el usuario pide:

- pasos bien separados (un modulo por responsabilidad, numerados en los
  comentarios: PASO 1, PASO 2, ...),
- comentarios que expliquen el *por que* de cada bloque, no solo el que,
- **nada hardcodeado** del subaccount actual (nombres de instancias, org,
  space, apps): todo se descubre en runtime para que sirva en cualquier
  subaccount.

**Why:** Lo dijo explicitamente al pedir cf-proxy (2026-09-04): "hace pasos
bien separados y comentados" y "lo importante es que no tiene que saber nada
de antemano de lo que hay en CF". Quiere reutilizarlo en otros subaccounts.

**How to apply:** Antes de escribir un nombre de instancia, app o destination
en el codigo, preguntarse si se puede descubrir con `cf` o con la API.
Estructurar en `lib/<paso>.js` + un orquestador que imprima `[n/N]` por paso.
El launcher en Python sigue el mismo criterio (`store.py`, `cf.py`, `paths.py`,
`app.py`). Rechazo explicito a extensiones de navegador: las considera mas
trabajo que el problema que resuelven. Ver [[naming-cf-resources]].
