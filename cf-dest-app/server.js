/**
 * cf-dest-app - App minima que despliega mta.yaml.
 *
 * No escucha en ningun puerto ni sirve nada: solo se queda viva para que la
 * app este STARTED y `cf ssh -L` pueda abrir un port-forward a traves de ella
 * hacia el Connectivity Proxy (que solo es alcanzable desde adentro de CF).
 *
 * En mta.yaml esta con `no-route` y `health-check-type: process`, asi que
 * alcanza con que el proceso no termine.
 */
console.log("cf-dest-app: activo.");

// Un timer largo mantiene el event loop vivo sin consumir CPU.
setInterval(() => {}, 1 << 30);
