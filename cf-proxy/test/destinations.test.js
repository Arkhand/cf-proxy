/**
 * Test de escritura del cliente de destinations (create / update).
 *
 * Corre contra un Destination Service FALSO en localhost, con un store en
 * memoria. No toca ningun subaccount ni lee ninguna service key: el token
 * viene del server falso. Sirve para verificar verbos, forma del payload,
 * el merge del update y el guard de confirmacion sin riesgo.
 *
 * Requiere `openssl` en el PATH para el cert autofirmado.
 *
 * Uso:  node test/destinations.test.js
 */
// Test local: servidor HTTPS falso que imita al Destination Service.
// No toca ningun tenant. Verifica verbos, forma del payload y merge.
const https=require("https");
const {execSync}=require("child_process");
const fs=require("fs"),os=require("os"),path=require("path");
process.env.NODE_TLS_REJECT_UNAUTHORIZED="0";

// Cert autofirmado minimo via node crypto (genera par y cert x509 con openssl si existe)
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"certs-"));
const key=path.join(dir,"k.pem"),crt=path.join(dir,"c.pem");
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${crt}" -days 1 -subj "/CN=localhost"`,{stdio:"ignore"});

const calls=[];
let store={ APPROVAL_HUB_API:{Name:"APPROVAL_HUB_API",URL:"https://old.example.com",Type:"HTTP",Authentication:"OAuth2UserTokenExchange",Description:"vieja",ExtraProp:"NO-SE-DEBE-PERDER"} };

const srv=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(crt)},(req,res)=>{
  let body="";req.on("data",c=>body+=c);req.on("end",()=>{
    const u=new URL(req.url,"https://x");
    if(u.pathname.endsWith("/oauth/token")){res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({access_token:"TOK",expires_in:3600}));}
    calls.push({method:req.method,path:u.pathname,body:body?JSON.parse(body):null});
    const m=u.pathname.match(/subaccountDestinations\/(.+)$/);
    if(req.method==="GET"&&m){const n=decodeURIComponent(m[1]);
      if(!store[n]){res.writeHead(404);return res.end("{}");}
      res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify(store[n]));}
    if(req.method==="POST"){const d=JSON.parse(body)[0];
      // Como el servicio real: duplicado = 207 con el 409 adentro del lote.
      if(store[d.Name]){res.writeHead(207);return res.end(JSON.stringify([{name:d.Name,status:"409",cause:"Requested duplicate configurations"}]));}
      store[d.Name]=d;res.writeHead(201);return res.end(JSON.stringify({Count:1}));}
    if(req.method==="DELETE"&&m){const n=decodeURIComponent(m[1]);
      if(!store[n]){res.writeHead(404);return res.end("nope");}
      delete store[n];res.writeHead(200);return res.end(JSON.stringify({Count:1}));}
    if(req.method==="PUT"){const d=JSON.parse(body)[0];
      if(!store[d.Name]){res.writeHead(207);return res.end(JSON.stringify([{name:d.Name,status:"404",cause:"Configuration not found"}]));}
      store[d.Name]=d;res.writeHead(200);return res.end(JSON.stringify({Count:1}));}
    res.writeHead(200);res.end("[]");
  });
});

srv.listen(0,async()=>{
  const port=srv.address().port;
  const {makeDestinationClient}=require("../lib/destinations");
  const c=makeDestinationClient({uri:`https://localhost:${port}`,url:`https://localhost:${port}`,clientid:"a",clientsecret:"b"});
  let failed=0;
  const ok=(n,cond)=>{ if(!cond) failed++; console.log((cond?"PASS  ":"FAIL  ")+n); };
  let e;

  // 1. create de una nueva -> POST, array de 1, Type default
  const r1=await c.create({Name:"NUEVA_DEST",URL:"https://new.example.com",Authentication:"NoAuthentication"},{confirm:"NUEVA_DEST"});
  const post=calls.find(x=>x.method==="POST");
  ok("create usa POST",post!==undefined);
  ok("create manda array de UNO",Array.isArray(post.body)&&post.body.length===1);
  ok("create pone Type=HTTP por default",post.body[0].Type==="HTTP");
  ok("create pone ProxyType=Internet por default",post.body[0].ProxyType==="Internet");
  ok("create devuelve created:true",r1.created===true&&r1.name==="NUEVA_DEST");

  // 2. create sobre existente -> 409 con mensaje claro
  e=null;try{await c.create({Name:"APPROVAL_HUB_API",URL:"https://x.com",Authentication:"NoAuthentication"},{confirm:"APPROVAL_HUB_API"});}catch(x){e=x;}
  ok("create sobre existente falla (207 con 409 adentro -> 'ya existe')",e&&/ya existe/.test(e.message));
  ok("create 409 sugiere update",e&&/update/.test(e.message));

  // 3. validaciones
  e=null;try{await c.create({URL:"https://x.com",Authentication:"NoAuthentication"});}catch(x){e=x;}
  ok("create sin Name falla",e&&/Name/.test(e.message));
  e=null;try{await c.create({Name:"OK",Authentication:"NoAuthentication"});}catch(x){e=x;}
  ok("create sin URL falla",e&&/URL/.test(e.message));
  e=null;try{await c.create({Name:"mal nombre!",URL:"https://x.com",Authentication:"NoAuthentication"});}catch(x){e=x;}
  ok("create con nombre invalido falla",e&&/no es un nombre valido/.test(e.message));
  e=null;try{await c.create({Name:"OK2",URL:"https://x.com"});}catch(x){e=x;}
  ok("create sin Authentication falla",e&&/Authentication/.test(e.message));

  // 4. update mergea: NO pierde ExtraProp
  calls.length=0;
  await c.update({Name:"APPROVAL_HUB_API",URL:"https://nueva.example.com"},{confirm:"APPROVAL_HUB_API"});
  const put=calls.find(x=>x.method==="PUT");
  ok("update usa PUT",put!==undefined);
  ok("update lee la actual antes (GET previo)",calls.some(x=>x.method==="GET"));
  ok("update NO pierde props no enviadas",put.body[0].ExtraProp==="NO-SE-DEBE-PERDER");
  ok("update aplica el cambio pedido",put.body[0].URL==="https://nueva.example.com");
  ok("update conserva Authentication",put.body[0].Authentication==="OAuth2UserTokenExchange");

  // 5. update con replace:true reemplaza entero
  calls.length=0;
  await c.update({Name:"APPROVAL_HUB_API",URL:"https://r.example.com",Authentication:"NoAuthentication"},{replace:true,confirm:"APPROVAL_HUB_API"});
  const put2=calls.find(x=>x.method==="PUT");
  ok("replace:true no hace GET previo",!calls.some(x=>x.method==="GET"));
  ok("replace:true descarta props viejas",put2.body[0].ExtraProp===undefined);

  // 6. update de inexistente
  e=null;try{await c.update({Name:"NO_EXISTE_XX",URL:"https://x.com"},{confirm:"NO_EXISTE_XX"});}catch(x){e=x;}
  ok("update de inexistente falla",e&&/no existe/.test(e.message));
  ok("update inexistente sugiere create",e&&/create/.test(e.message));
  e=null;try{await c.update({Name:"NO_EXISTE_YY",URL:"https://x.com",Authentication:"NoAuthentication"},{replace:true,confirm:"NO_EXISTE_YY"});}catch(x){e=x;}
  ok("update replace de inexistente (207 con 404 adentro) falla con 'no existe'",e&&/no existe/.test(e.message));

  // 7. raw devuelve null si no existe
  ok("raw devuelve null si no existe",(await c.raw("NADA_ACA"))===null);


  // ===== GUARD DE CONFIRMACION =====
  calls.length=0;
  e=null;try{await c.create({Name:"SIN_CONFIRM",URL:"https://x.com",Authentication:"NoAuthentication"});}catch(x){e=x;}
  ok("create SIN confirm falla",e&&/CONFIRMACION REQUERIDA/.test(e.message));
  ok("create sin confirm NO manda nada a la red",!calls.some(x=>x.method==="POST"));
  ok("el error explica como confirmar",e&&/confirm: "SIN_CONFIRM"/.test(e.message));
  ok("el error avisa de verificar cf target",e&&/cf target/.test(e.message));

  calls.length=0;
  e=null;try{await c.create({Name:"OTRA",URL:"https://x.com",Authentication:"NoAuthentication"},{confirm:"NOMBRE_DISTINTO"});}catch(x){e=x;}
  ok("create con confirm ERRADO falla",e&&/no coincide/.test(e.message));
  ok("confirm errado NO escribe",!calls.some(x=>x.method==="POST"));

  calls.length=0;
  e=null;try{await c.update({Name:"APPROVAL_HUB_API",URL:"https://z.com"});}catch(x){e=x;}
  ok("update SIN confirm falla",e&&/CONFIRMACION REQUERIDA/.test(e.message));
  ok("update sin confirm NO manda PUT",!calls.some(x=>x.method==="PUT"));
  ok("update sin confirm ni siquiera hace GET",!calls.some(x=>x.method==="GET"));
  ok("mensaje dice ACTUALIZAR",e&&/ACTUALIZAR/.test(e.message));

  e=null;try{await c.update({Name:"APPROVAL_HUB_API",URL:"https://z.com"},{replace:true});}catch(x){e=x;}
  ok("replace sin confirm dice REEMPLAZAR",e&&/REEMPLAZAR/.test(e.message));

  // ===== PREVIEW (no escribe) =====
  calls.length=0;
  const pv=await c.preview("update",{Name:"APPROVAL_HUB_API",URL:"https://preview.example.com"});
  ok("preview NO escribe nada",!calls.some(x=>x.method==="PUT"||x.method==="POST"));
  ok("preview marca que existe",pv.exists===true);
  ok("preview lista los cambios",pv.changes.some(x=>x.property==="URL"&&x.after==="https://preview.example.com"));
  ok("preview trae warning",typeof pv.warning==="string"&&pv.warning.length>0);

  // Dest limpia y aislada: el store fue mutado por el test 5 de replace.
  store.DEST_CON_EXTRAS={Name:"DEST_CON_EXTRAS",URL:"https://a.com",Type:"HTTP",Authentication:"NoAuthentication",PropQueSePierde:"chau"};
  const pvr=await c.preview("update",{Name:"DEST_CON_EXTRAS",URL:"https://r.com",Authentication:"NoAuthentication"},{replace:true});
  ok("preview con replace avisa que se PIERDEN props",/PIERDEN/.test(pvr.warning));
  ok("preview con replace identifica CUAL se pierde",pvr.changes.some(x=>x.property==="PropQueSePierde"&&x.after==="(SE PIERDE)"));

  const pvc=await c.preview("create",{Name:"APPROVAL_HUB_API",URL:"https://x.com",Authentication:"NoAuthentication"});
  ok("preview create sobre existente avisa del 409",/409/.test(pvc.warning));

  const pvn=await c.preview("create",{Name:"DEST_INEXISTENTE",URL:"https://x.com",Authentication:"NoAuthentication"});
  ok("preview create nueva dice que se va a CREAR",/Se va a CREAR/.test(pvn.warning));

  // ===== NULL = QUITAR PROPIEDAD =====
  store.CON_EXTRAS={Name:"CON_EXTRAS",URL:"https://a.com",Type:"HTTP",Authentication:"BasicAuthentication",User:"u",Password:"pw","sap-client":"100",Custom:"x"};
  calls.length=0;
  const pvq=await c.preview("update",{Name:"CON_EXTRAS","sap-client":null,Authentication:"NoAuthentication",User:null,Password:null});
  ok("preview marca (SE QUITA) lo pedido en null",pvq.changes.some(x=>x.property==="sap-client"&&x.after==="(SE QUITA)"));
  ok("preview marca (SE QUITA) tambien un secreto (Password)",pvq.changes.some(x=>x.property==="Password"&&x.after==="(SE QUITA)"));
  ok("preview NO marca (SE PIERDE) cuando es null explicito",!pvq.changes.some(x=>x.after==="(SE PIERDE)"));
  ok("preview cuenta los que se quitan en el warning",/Se QUITAN 3/.test(pvq.warning));
  ok("preview willSend no trae las quitadas",pvq.willSend["sap-client"]===undefined&&pvq.willSend.User===undefined);
  ok("preview willSend conserva lo no tocado (Custom)",pvq.willSend.Custom==="x");
  calls.length=0;
  await c.update({Name:"CON_EXTRAS","sap-client":null,Authentication:"NoAuthentication",User:null,Password:null},{confirm:"CON_EXTRAS"});
  const putq=calls.find(x=>x.method==="PUT");
  ok("update con null NO manda esas propiedades",!("sap-client" in putq.body[0])&&!("User" in putq.body[0])&&!("Password" in putq.body[0]));
  ok("update con null aplica el cambio de auth y conserva Custom",putq.body[0].Authentication==="NoAuthentication"&&putq.body[0].Custom==="x");
  ok("update con null NO manda literal null",!Object.values(putq.body[0]).some(v=>v===null));
  e=null;try{await c.preview("update",{Name:"CON_EXTRAS",URL:null});}catch(x){e=x;}
  ok("quitar URL falla (es obligatoria)",e&&/URL/.test(e.message));
  calls.length=0;
  await c.create({Name:"SIN_NULLS",URL:"https://s.com",Authentication:"NoAuthentication",Description:null},{confirm:"SIN_NULLS"});
  ok("create descarta propiedades en null",!("Description" in calls.find(x=>x.method==="POST").body[0]));

  // ===== REMOVE =====
  calls.length=0;
  e=null;try{await c.remove("OTRA_DEL");}catch(x){e=x;}
  ok("remove SIN confirm falla",e&&/CONFIRMACION REQUERIDA para ELIMINAR/.test(e.message));
  ok("remove sin confirm NO manda nada a la red",calls.length===0);
  e=null;try{await c.remove("OTRA_DEL",{confirm:"OTRO"});}catch(x){e=x;}
  ok("remove con confirm errado falla y no escribe",e&&/no coincide/.test(e.message)&&calls.length===0);
  e=null;try{await c.remove("NO_EXISTE_DEL",{confirm:"NO_EXISTE_DEL"});}catch(x){e=x;}
  ok("remove de inexistente falla con mensaje claro",e&&/no existe/.test(e.message));
  ok("remove de inexistente NO manda DELETE",!calls.some(x=>x.method==="DELETE"));
  store.PARA_BORRAR={Name:"PARA_BORRAR",URL:"https://b.com",Type:"HTTP",Authentication:"BasicAuthentication",User:"u",Password:"pw"};
  calls.length=0;
  const rd=await c.remove("PARA_BORRAR",{confirm:"PARA_BORRAR"});
  const del=calls.find(x=>x.method==="DELETE");
  ok("remove usa DELETE sobre la ruta puntual del nombre",del&&/subaccountDestinations\/PARA_BORRAR$/.test(del.path));
  ok("remove lee la definicion ANTES de borrar",calls[0].method==="GET"&&calls[1].method==="DELETE");
  ok("remove devuelve backup completo",rd.deleted===true&&rd.backup.Password==="pw"&&rd.backup.URL==="https://b.com");
  ok("remove realmente saco la destination",(await c.raw("PARA_BORRAR"))===null);

  console.log("");
  console.log(failed ? failed + " test(s) FALLARON" : "Todos los tests pasaron");
  srv.close();
  process.exit(failed ? 1 : 0);
});
