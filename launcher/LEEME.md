# cf-proxy

Proxy local hacia las **destinations de un subaccount de SAP BTP**. Con él, una
app UI5 (o Postman, o un script) que corre en tu PC llama a
`http://localhost:<puerto>/<DESTINATION>/<path>` y el proxy se encarga del
resto: credenciales, OAuth, Cloud Connector y túnel on-premise.

No hace falta BAS, ni cookies, ni `.env`. Cada cliente es un **perfil**, con
su propio puerto y su propia sesión de Cloud Foundry, así que podés tener
varios clientes corriendo a la vez.

```
cf-proxy-launcher/
  cf-proxy.exe          ← la ventana (doble clic)
  LEEME.md              ← este archivo
  recursos/
    cf-proxy/           ← el proxy (Node)
    cf-dest_1.0.0.mtar  ← recursos para desplegar en un space, si faltan
```

---

## 1. Requisitos

Tienen que estar instalados y en el `PATH`:

| Herramienta | Para instalar |
|---|---|
| Cloud Foundry CLI (`cf`) v8 | `winget install CloudFoundry.CloudFoundryCLI` |
| Node.js 16 o más nuevo | `winget install OpenJS.NodeJS.LTS` |

La ventana los verifica al abrir y te dice cuál falta. Si vas a desplegar los
recursos (paso 4), también hace falta el plugin `multiapps` de `cf`:
`cf install-plugin multiapps -f`.

En BTP necesitás el rol **SpaceDeveloper** en el space del cliente: para leer
las service keys y, si hace falta, para desplegar.

## 2. Primer uso: crear el perfil de un cliente

Un perfil = **una subcuenta** de un cliente. Lo creás una vez.

1. Abrí `cf-proxy.exe` y tocá **Nuevo**.
2. Completá:
   - **Nombre**: corto, sin espacios (`acme`, `bms-dev`). No se puede cambiar después.
   - **Título**: lo que vas a ver en las pestañas (`ACME – Desarrollo`).
   - **API endpoint**: el de la región del subaccount, p.ej.
     `https://api.cf.us10-001.hana.ondemand.com`. Está en el cockpit, en la
     pantalla del subaccount, bajo *Cloud Foundry Environment*.
   - **Usuario** y **Login**: *Contraseña* para usuarios del IdP de SAP;
     *SSO* si el cliente usa su IdP corporativo (te pide un passcode que sacás
     del browser).
3. Tocá **Conectar y listar orgs**. Se loguea con la sesión **de ese perfil** y
   carga los orgs y spaces que tu usuario ve de verdad.
4. Elegí **Org** y **Space**.
5. **Puerto**: dejalo vacío y toma el siguiente libre (3100, 3101…). Dos
   perfiles nunca comparten puerto.
6. **Guardar**.

Opciones del perfil:

| Opción | Cuándo marcarla |
|---|---|
| Forzar túnel SSH | Destinations on-premise y el space no tiene `cf-dest-app` |
| Abrir login de usuario | Si usás destinations PrincipalPropagation / UserTokenExchange |
| Permitir crear service keys | Si las instancias del space no tienen ninguna key usable |
| Abrir la página al arrancar | Abre `http://localhost:<puerto>/` al iniciar |

## 3. Arrancar un proxy

Seleccioná el perfil y tocá **Iniciar**.

- El proxy queda corriendo **en segundo plano** y aparece una **pestaña** con
  su estado, el log en vivo y los botones *Abrir página*, *Login de usuario*,
  *Detener* y *Cerrar pestaña*.
- Si el perfil no tiene sesión de `cf` (primera vez, o venció), te pide login y
  reintenta solo.
- Podés iniciar varios perfiles: cada uno en su puerto y su pestaña.

Desde tu app, apuntá al puerto del perfil. En el `ui5.yaml`:

```yaml
- path: /sap/opu/odata/sap/API_BILLOFMATERIAL_SRV
  pathPrefix: /MI_DESTINATION/sap/opu/odata/sap/API_BILLOFMATERIAL_SRV
  url: http://localhost:3100
```

O directo en el browser: `http://localhost:3100/MI_DESTINATION/<path>`.

La **página** del proxy (`http://localhost:<puerto>/`) lista las destinations
del subaccount, dice cuáles van a funcionar y permite **probar, crear, editar
y borrar** destinations (las escrituras piden confirmación tipeando el nombre).

## 4. Si el space no tiene los recursos

La primera vez en un space puede faltar la instancia `cf-dest-destination`.
La ventana lo detecta y ofrece **desplegar** el `.mtar` incluido, con la
sesión del perfil y en el org/space del perfil. Crea, todo con prefijo
`cf-dest-`:

| Recurso | Para qué |
|---|---|
| `cf-dest-destination` | Leer y resolver destinations |
| `cf-dest-connectivity` | Llegar al Cloud Connector |
| `cf-dest-xsuaa` | Login de usuario (PrincipalPropagation, UserTokenExchange) |
| `cf-dest-app` | App mínima sin ruta, solo para el túnel SSH on-premise |

No toca nada más del subaccount. Si no querés desplegar, el proxy igual
funciona reutilizando las instancias que ya haya; lo único que no anda sin el
deploy es el login de usuario.

## 5. Login de usuario (PrincipalPropagation / UserTokenExchange)

Algunas destinations necesitan **tu** identidad, no una credencial técnica.
La pestaña lo muestra: *"Login de usuario: FALTA"* en rojo. Tocá **Login de
usuario**, logueate en el browser y listo: la sesión dura semanas y se renueva
sola.

> **Puerto distinto de 3100:** el login vuelve a `http://localhost:<puerto>`, y
> el XSUAA solo acepta los puertos que figuran en su configuración. Si la
> pestaña avisa *"el puerto no está en las redirect-uris"*, hay que agregar el
> puerto en `recursos/cf-proxy/xs-security.json` y actualizar el XSUAA de esa
> subcuenta:
>
> ```
> node bin\cf-proxy.js cf <perfil> -- update-service cf-dest-xsuaa -c xs-security.json
> ```

## 6. Cerrar la ventana

La ventana es solo una consola de administración: los proxies corren aparte.
Al cerrarla te pregunta **solo por los que iniciaste desde ella**:

- **Sí** → los detiene y cierra.
- **No** → cierra y **los deja corriendo**. Al reabrir la ventana vuelven a
  aparecer sus pestañas.
- **Cancelar** → no cierra.

Los que se iniciaron desde una terminal nunca se tocan.

## 7. Por consola (y para usarlo desde una IA)

Todo lo que hace la ventana se puede hacer desde una terminal, en
`recursos\cf-proxy`. La ventana y la consola ven lo mismo.

```bat
cd recursos\cf-proxy

node bin\cf-proxy.js profiles list             :: perfiles y si tienen problemas
node bin\cf-proxy.js login acme                :: login de cf del perfil
node bin\cf-proxy.js start acme                :: arranca (o devuelve la URL si ya corre)
node bin\cf-proxy.js ps                        :: qué corre: título, usuario, org/space, puerto, estado, login
node bin\cf-proxy.js logs acme -f              :: salida en vivo
node bin\cf-proxy.js stop acme
node bin\cf-proxy.js cf acme -- services       :: cualquier comando de cf, con la sesión del perfil
```

- Agregá `--json` a cualquier comando para obtener un solo objeto JSON: es lo
  que conviene para scripts o para una skill de IA.
- `start` es **idempotente**: si dos sesiones piden el mismo cliente, la
  segunda recibe la URL del que ya corre (`"already": true`).
- `cf <perfil> -- …` imprime antes a qué api/org/space va y **se niega a
  apuntar a otro org**. Usalo para deploys en vez de `cf` suelto.

## 8. Lo que tenés que saber

- **No toca tu sesión global de `cf`.** Cada perfil tiene la suya en
  `%USERPROFILE%\.cf-proxy\profiles\<perfil>\`. Tu terminal sigue apuntando
  donde estaba, y un deploy por consola no sale al cliente equivocado por un
  `cf target` olvidado.
- **Una subcuenta, un perfil.** No se pueden crear dos perfiles para el mismo
  org en la misma región, ni dos con el mismo puerto. El proxy de un perfil no
  puede cambiar de org (sí de space, desde su página).
- **Contraseñas:** se guardan cifradas con tu cuenta de Windows (DPAPI). El
  archivo no sirve en otra PC ni para otro usuario. Nunca van en texto plano
  ni en la línea de comandos.
- **Solo para desarrollo.** No interviene en cómo se despliegan las apps.

## 9. Dónde se guarda todo

| Ruta | Qué tiene |
|---|---|
| `%USERPROFILE%\.cf-proxy\profiles.json` | Los perfiles (sin secretos) |
| `%USERPROFILE%\.cf-proxy\profiles\<perfil>\` | La sesión de `cf` de cada perfil |
| `%USERPROFILE%\.cf-proxy\runs\` | Proxies corriendo (`.json`) y su salida (`.log`) |
| `%USERPROFILE%\.cf-proxy\user-token-*.json` | Sesiones de login de usuario |
| `%APPDATA%\cf-proxy-launcher\secrets.bin` | Contraseñas (DPAPI) |

Para empezar de cero, cerrá todo y borrá esas carpetas.

## 10. Problemas frecuentes

| Ves | Qué pasa | Qué hacer |
|---|---|---|
| Perfil en rojo: *el puerto N lo usa X* | Dos perfiles con el mismo puerto | **Editar** y dejar el puerto vacío |
| *Login OK, pero el org X no existe* | El org guardado no es de ese usuario/región | **Editar** → *Conectar y listar orgs* → elegir el correcto |
| *no tiene sesión de CF* | Primera vez o venció | **Login** (o se pide solo al iniciar) |
| *Puerto ocupado* | Otro programa usa ese puerto | Cambiar el puerto del perfil |
| Login de usuario vuelve con `invalid_redirect` | El puerto no está en el XSUAA | Ver §5 |
| *Insufficient scope* en una destination UserTokenExchange | El XSUAA es de una versión vieja | Redesplegar (§4) o `update-service` (§5) y volver a hacer *Login de usuario* |
| Destination on-premise da 501 | No hay túnel | Desplegar los recursos (§4) o marcar *Forzar túnel SSH* |
| La pestaña queda en *starting* | Sigue arrancando (descubrir servicios tarda) | Mirar el log de la pestaña |

Si algo no arranca, el log de la pestaña (o `node bin\cf-proxy.js logs
<perfil>`) dice en qué paso se cortó.
