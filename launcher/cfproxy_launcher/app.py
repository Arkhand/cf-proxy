"""
PASO 3 - La ventana del launcher.

Objetivo: que arrancar cf-proxy sea doble clic + elegir perfil, sin tocar la
terminal. Lo que hace, en orden:

  1. Verifica que `cf` y `node` esten instalados. Sin eso no se puede seguir.
  2. Perfil: api endpoint, usuario, metodo de login, org/space, puerto, flags.
  3. Conecta (password o SSO) y lista orgs/spaces reales del usuario.
  4. Si el space no tiene la instancia de `destination`, ofrece desplegar el
     .mtar que viene en el paquete.
  5. Lanza `node server.js` con los flags elegidos y muestra el log.

NO reemplaza nada del proxy: ejecuta el mismo `server.js` que se corre a mano,
asi que la linea de comandos sigue funcionando igual.
"""
import queue
import threading
import tkinter as tk
import webbrowser
from pathlib import Path
from tkinter import messagebox, ttk

from . import cf, store
from .paths import find_proxy_dir, find_mtar

PAD = {"padx": 8, "pady": 4}


class LauncherApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("cf-proxy")
        self.geometry("820x640")
        self.minsize(760, 560)

        # Cola de mensajes: los hilos de trabajo no tocan widgets directamente,
        # escriben aca y el hilo de la UI los consume (tkinter no es thread-safe).
        self.messages = queue.Queue()
        self.proxy_thread = None
        self.proxy_running = False
        self.targets = []

        self.proxy_dir = find_proxy_dir()
        self.mtar = find_mtar()

        self._build()
        self._load_profiles()
        self.after(100, self._drain)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        # El chequeo de requisitos va despues de dibujar, para poder mostrarlo
        # en la ventana en vez de morir con un traceback.
        self.after(200, self._check_requirements)

    # -----------------------------------------------------------------
    # Construccion de la ventana
    # -----------------------------------------------------------------
    def _build(self):
        root = ttk.Frame(self, padding=10)
        root.pack(fill="both", expand=True)
        root.columnconfigure(0, weight=1)
        root.rowconfigure(2, weight=1)

        self._build_profile(root).grid(row=0, column=0, sticky="ew", pady=(0, 8))
        self._build_options(root).grid(row=1, column=0, sticky="ew", pady=(0, 8))
        self._build_log(root).grid(row=2, column=0, sticky="nsew")
        self._build_actions(root).grid(row=3, column=0, sticky="ew", pady=(8, 0))

    def _build_profile(self, parent):
        box = ttk.LabelFrame(parent, text="Cuenta", padding=8)
        box.columnconfigure(1, weight=1)

        ttk.Label(box, text="Perfil").grid(row=0, column=0, sticky="w", **PAD)
        self.profile_var = tk.StringVar()
        self.profile_combo = ttk.Combobox(box, textvariable=self.profile_var, state="readonly")
        self.profile_combo.grid(row=0, column=1, sticky="ew", **PAD)
        self.profile_combo.bind("<<ComboboxSelected>>", lambda e: self._apply_profile())
        ttk.Button(box, text="Olvidar", command=self._forget).grid(row=0, column=2, **PAD)

        ttk.Label(box, text="API endpoint").grid(row=1, column=0, sticky="w", **PAD)
        self.api_var = tk.StringVar(value=store.DEFAULT_PROFILE["api"])
        ttk.Entry(box, textvariable=self.api_var).grid(row=1, column=1, columnspan=2, sticky="ew", **PAD)

        ttk.Label(box, text="Usuario").grid(row=2, column=0, sticky="w", **PAD)
        self.user_var = tk.StringVar()
        ttk.Entry(box, textvariable=self.user_var).grid(row=2, column=1, columnspan=2, sticky="ew", **PAD)

        # Metodo de login: con password guardada, o SSO con passcode del browser.
        self.auth_var = tk.StringVar(value="password")
        methods = ttk.Frame(box)
        methods.grid(row=3, column=1, columnspan=2, sticky="w", **PAD)
        ttk.Radiobutton(methods, text="Contraseña", value="password", variable=self.auth_var,
                        command=self._toggle_auth).pack(side="left")
        ttk.Radiobutton(methods, text="SSO (passcode del browser)", value="sso", variable=self.auth_var,
                        command=self._toggle_auth).pack(side="left", padx=(12, 0))
        ttk.Label(box, text="Login").grid(row=3, column=0, sticky="w", **PAD)

        ttk.Label(box, text="Contraseña").grid(row=4, column=0, sticky="w", **PAD)
        self.pass_var = tk.StringVar()
        self.pass_entry = ttk.Entry(box, textvariable=self.pass_var, show="•")
        self.pass_entry.grid(row=4, column=1, sticky="ew", **PAD)
        self.remember_var = tk.BooleanVar(value=True)
        self.remember_check = ttk.Checkbutton(box, text="Recordar", variable=self.remember_var)
        self.remember_check.grid(row=4, column=2, sticky="w", **PAD)

        ttk.Button(box, text="Conectar", command=self._connect).grid(row=5, column=1, sticky="w", **PAD)
        self.conn_var = tk.StringVar(value="Sin conectar.")
        ttk.Label(box, textvariable=self.conn_var, foreground="#555").grid(
            row=5, column=2, sticky="w", **PAD)
        return box

    def _build_options(self, parent):
        box = ttk.LabelFrame(parent, text="Destino y opciones", padding=8)
        box.columnconfigure(1, weight=1)
        box.columnconfigure(3, weight=1)

        ttk.Label(box, text="Org").grid(row=0, column=0, sticky="w", **PAD)
        self.org_var = tk.StringVar()
        self.org_combo = ttk.Combobox(box, textvariable=self.org_var, state="readonly")
        self.org_combo.grid(row=0, column=1, sticky="ew", **PAD)
        self.org_combo.bind("<<ComboboxSelected>>", lambda e: self._fill_spaces())

        ttk.Label(box, text="Space").grid(row=0, column=2, sticky="w", **PAD)
        self.space_var = tk.StringVar()
        self.space_combo = ttk.Combobox(box, textvariable=self.space_var, state="readonly")
        self.space_combo.grid(row=0, column=3, sticky="ew", **PAD)

        ttk.Label(box, text="Puerto").grid(row=1, column=0, sticky="w", **PAD)
        self.port_var = tk.StringVar(value="3100")
        ttk.Spinbox(box, from_=1024, to=65535, textvariable=self.port_var, width=8).grid(
            row=1, column=1, sticky="w", **PAD)

        flags = ttk.Frame(box)
        flags.grid(row=2, column=0, columnspan=4, sticky="w", **PAD)
        self.tunnel_var = tk.BooleanVar()
        self.login_var = tk.BooleanVar()
        self.keys_var = tk.BooleanVar()
        self.open_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(flags, text="Forzar túnel SSH (on-premise)", variable=self.tunnel_var).pack(side="left")
        ttk.Checkbutton(flags, text="Abrir login de usuario", variable=self.login_var).pack(side="left", padx=(12, 0))
        ttk.Checkbutton(flags, text="Permitir crear service keys", variable=self.keys_var).pack(side="left", padx=(12, 0))
        ttk.Checkbutton(flags, text="Abrir la página al arrancar", variable=self.open_var).pack(side="left", padx=(12, 0))
        return box

    def _build_log(self, parent):
        box = ttk.LabelFrame(parent, text="Salida", padding=4)
        box.columnconfigure(0, weight=1)
        box.rowconfigure(0, weight=1)

        self.log = tk.Text(box, wrap="none", height=14, state="disabled",
                           background="#1e1e1e", foreground="#d4d4d4",
                           insertbackground="#d4d4d4", font=("Consolas", 9))
        self.log.grid(row=0, column=0, sticky="nsew")
        bar = ttk.Scrollbar(box, orient="vertical", command=self.log.yview)
        bar.grid(row=0, column=1, sticky="ns")
        self.log.configure(yscrollcommand=bar.set)

        # Colores por tipo de linea, para que el error salte a la vista.
        self.log.tag_configure("err", foreground="#f48771")
        self.log.tag_configure("ok", foreground="#89d185")
        self.log.tag_configure("info", foreground="#9cdcfe")
        return box

    def _build_actions(self, parent):
        box = ttk.Frame(parent)
        box.columnconfigure(1, weight=1)

        self.start_btn = ttk.Button(box, text="Iniciar cf-proxy", command=self._start)
        self.start_btn.grid(row=0, column=0, sticky="w")
        self.stop_btn = ttk.Button(box, text="Detener", command=self._stop, state="disabled")
        self.stop_btn.grid(row=0, column=1, sticky="w", padx=(8, 0))

        self.open_btn = ttk.Button(box, text="Abrir página", command=self._open_page, state="disabled")
        self.open_btn.grid(row=0, column=2, sticky="e", padx=(8, 0))
        ttk.Button(box, text="Guardar perfil", command=self._save_profile).grid(
            row=0, column=3, sticky="e", padx=(8, 0))

        self.status_var = tk.StringVar(value="Verificando requisitos…")
        ttk.Label(box, textvariable=self.status_var, foreground="#555").grid(
            row=1, column=0, columnspan=4, sticky="w", pady=(6, 0))
        return box

    # -----------------------------------------------------------------
    # Mensajes entre hilos
    # -----------------------------------------------------------------
    def _say(self, text, tag=None):
        """Escribe en el log. Seguro desde cualquier hilo."""
        self.messages.put(("log", text, tag))

    def _drain(self):
        """Consume la cola en el hilo de la UI. tkinter no es thread-safe."""
        while True:
            try:
                kind, *rest = self.messages.get_nowait()
            except queue.Empty:
                break
            if kind == "log":
                self._write(rest[0], rest[1])
            elif kind == "call":
                rest[0]()
        self.after(100, self._drain)

    def _write(self, text, tag=None):
        if tag is None:
            low = text.lower()
            tag = "err" if ("error" in low or "fail" in low) else \
                  "ok" if text.lstrip().startswith("OK") else None
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n", tag or ())
        self.log.see("end")
        self.log.configure(state="disabled")

    def _ui(self, fn):
        """Ejecuta `fn` en el hilo de la UI desde un hilo de trabajo."""
        self.messages.put(("call", fn))

    def _background(self, fn):
        threading.Thread(target=fn, daemon=True).start()

    # -----------------------------------------------------------------
    # PASO 1 - Requisitos
    # -----------------------------------------------------------------
    def _check_requirements(self):
        def work():
            missing = cf.check_requirements()
            if missing:
                detail = "\n\n".join(f"• {m['tool']}\n   {m['hint']}" for m in missing)
                self._say("Faltan requisitos:", "err")
                for m in missing:
                    self._say(f"  - {m['tool']}: {m['hint']}", "err")
                self._ui(lambda: self._requirements_failed(detail))
                return

            v = cf.versions()
            self._ui(lambda: self.status_var.set(f"cf {v['cf']}  ·  node {v['node']}  ·  listo."))
            self._say(f"cf {v['cf']} y node {v['node']} detectados.", "ok")

            if not self.proxy_dir:
                self._say("No se encontro la carpeta de cf-proxy junto al ejecutable.", "err")
                self._ui(lambda: self.status_var.set("Falta la carpeta recursos/cf-proxy."))
                return
            self._say(f"cf-proxy: {self.proxy_dir}", "info")

            # Si ya hay sesion abierta, se aprovecha: evita pedir credenciales.
            target = cf.current_target()
            if target["logged"]:
                self._ui(lambda: self._session_ready(target, announce=True))

        self._background(work)

    def _requirements_failed(self, detail):
        self.status_var.set("Faltan requisitos. Ver la salida.")
        self.start_btn.configure(state="disabled")
        messagebox.showerror("Faltan requisitos", detail, parent=self)

    # -----------------------------------------------------------------
    # PASO 2 - Perfiles
    # -----------------------------------------------------------------
    def _load_profiles(self):
        self.profiles = store.load_profiles()
        names = [p["name"] for p in self.profiles]
        self.profile_combo.configure(values=names + ["<nuevo>"])
        if names:
            self.profile_var.set(names[0])
            self._apply_profile()
        else:
            self.profile_var.set("<nuevo>")
        self._toggle_auth()

    def _current_profile(self):
        return next((p for p in self.profiles if p["name"] == self.profile_var.get()), None)

    def _apply_profile(self):
        p = self._current_profile()
        if not p:
            return
        self.api_var.set(p["api"])
        self.user_var.set(p["user"])
        self.auth_var.set(p["auth"])
        self.port_var.set(str(p["port"]))
        self.tunnel_var.set(p["tunnel"])
        self.login_var.set(p["login"])
        self.keys_var.set(p["create_keys"])
        self.open_var.set(p["open_browser"])
        self.pass_var.set(store.get_password(p["name"]))
        # Org y space se ofrecen ya elegidos; se validan al conectar.
        self.org_combo.configure(values=[p["org"]] if p["org"] else [])
        self.org_var.set(p["org"])
        self.space_combo.configure(values=[p["space"]] if p["space"] else [])
        self.space_var.set(p["space"])
        self._toggle_auth()

    def _save_profile(self):
        name = self.profile_var.get().strip()
        if name in ("", "<nuevo>"):
            name = self._ask_name()
            if not name:
                return

        data = {
            "name": name,
            "api": self.api_var.get().strip(),
            "user": self.user_var.get().strip(),
            "auth": self.auth_var.get(),
            "org": self.org_var.get().strip(),
            "space": self.space_var.get().strip(),
            "port": int(self.port_var.get() or 3100),
            "tunnel": self.tunnel_var.get(),
            "login": self.login_var.get(),
            "create_keys": self.keys_var.get(),
            "open_browser": self.open_var.get(),
        }
        self.profiles = [p for p in self.profiles if p["name"] != name] + [data]
        store.save_profiles(self.profiles)

        # La contrasena solo si se pidio recordarla, y solo para login local.
        if self.auth_var.get() == "password" and self.remember_var.get():
            store.set_password(name, self.pass_var.get())
        else:
            store.set_password(name, "")

        names = [p["name"] for p in self.profiles]
        self.profile_combo.configure(values=names + ["<nuevo>"])
        self.profile_var.set(name)
        self._say(f"Perfil `{name}` guardado.", "ok")

    def _ask_name(self):
        win = tk.Toplevel(self)
        win.title("Nombre del perfil")
        win.transient(self)
        win.grab_set()
        win.resizable(False, False)
        var = tk.StringVar()
        ttk.Label(win, text="Nombre del perfil:").grid(row=0, column=0, sticky="w", padx=10, pady=(10, 4))
        entry = ttk.Entry(win, textvariable=var, width=32)
        entry.grid(row=1, column=0, columnspan=2, sticky="ew", padx=10)
        entry.focus_set()
        result = {}

        def accept():
            result["name"] = var.get().strip()
            win.destroy()

        ttk.Button(win, text="Guardar", command=accept).grid(row=2, column=0, sticky="e", padx=10, pady=10)
        ttk.Button(win, text="Cancelar", command=win.destroy).grid(row=2, column=1, sticky="w", pady=10)
        entry.bind("<Return>", lambda e: accept())
        self.wait_window(win)
        return result.get("name")

    def _forget(self):
        name = self.profile_var.get()
        if not self._current_profile():
            return
        if not messagebox.askyesno("Olvidar perfil",
                                   f"Se borra el perfil `{name}` y su contraseña guardada.\n\n¿Seguir?",
                                   parent=self):
            return
        store.forget_profile(name)
        self._say(f"Perfil `{name}` borrado.", "info")
        self._load_profiles()

    def _toggle_auth(self):
        """Con SSO no hay contrasena que escribir ni que recordar."""
        state = "normal" if self.auth_var.get() == "password" else "disabled"
        self.pass_entry.configure(state=state)
        self.remember_check.configure(state=state)

    # -----------------------------------------------------------------
    # PASO 3 - Conectar y listar orgs/spaces
    # -----------------------------------------------------------------
    def _connect(self):
        api = self.api_var.get().strip()
        user = self.user_var.get().strip()
        if not api:
            messagebox.showwarning("Falta el endpoint", "Indicá el API endpoint.", parent=self)
            return

        if self.auth_var.get() == "sso":
            self._connect_sso(api)
            return

        if not user or not self.pass_var.get():
            messagebox.showwarning("Faltan credenciales",
                                   "Usuario y contraseña, o elegí SSO.", parent=self)
            return

        password = self.pass_var.get()
        self.conn_var.set("Conectando…")
        self._say(f"cf login -a {api} -u {user}", "info")

        def work():
            ok, msg = cf.login_password(api, user, password)
            if not ok:
                self._say(msg, "err")
                self._ui(lambda: self.conn_var.set("No se pudo conectar."))
                # El CLI avisa cuando el subaccount exige SSO: se ofrece cambiar.
                if "sso" in msg.lower():
                    self._ui(lambda: self._offer_sso(api))
                return
            self._ui(lambda: self._session_ready(cf.current_target(), announce=True))

        self._background(work)

    def _offer_sso(self, api):
        if messagebox.askyesno(
                "Este subaccount usa SSO",
                "El login con contraseña fue rechazado y el CLI indica SSO.\n\n"
                "¿Cambiar a login por SSO (passcode del browser)?", parent=self):
            self.auth_var.set("sso")
            self._toggle_auth()
            self._connect_sso(api)

    def _connect_sso(self, api):
        self.conn_var.set("Preparando SSO…")

        def work():
            ok, url_or_err = cf.sso_url(api)
            if not ok:
                self._say(url_or_err, "err")
                self._ui(lambda: self.conn_var.set("No se pudo apuntar al endpoint."))
                return
            self._say(f"Abriendo {url_or_err} para el passcode.", "info")
            webbrowser.open(url_or_err)
            self._ui(lambda: self._ask_passcode(api, url_or_err))

        self._background(work)

    def _ask_passcode(self, api, url):
        self.conn_var.set("Esperando passcode…")
        win = tk.Toplevel(self)
        win.title("Passcode SSO")
        win.transient(self)
        win.grab_set()
        var = tk.StringVar()
        ttk.Label(win, text="Se abrió el browser. Copiá el passcode temporal y pegalo acá:",
                  wraplength=380).grid(row=0, column=0, columnspan=2, sticky="w", padx=10, pady=(10, 6))
        ttk.Label(win, text=url, foreground="#0a6ed1", wraplength=380).grid(
            row=1, column=0, columnspan=2, sticky="w", padx=10)
        entry = ttk.Entry(win, textvariable=var, width=40, show="•")
        entry.grid(row=2, column=0, columnspan=2, sticky="ew", padx=10, pady=8)
        entry.focus_set()

        def accept():
            code = var.get().strip()
            win.destroy()
            if not code:
                self.conn_var.set("SSO cancelado.")
                return
            self.conn_var.set("Validando passcode…")

            def work():
                ok, msg = cf.login_sso(api, code)
                if not ok:
                    self._say(msg, "err")
                    self._ui(lambda: self.conn_var.set("Passcode rechazado."))
                    return
                self._ui(lambda: self._session_ready(cf.current_target(), announce=True))

            self._background(work)

        ttk.Button(win, text="Conectar", command=accept).grid(row=3, column=0, sticky="e", padx=10, pady=10)
        ttk.Button(win, text="Cancelar", command=win.destroy).grid(row=3, column=1, sticky="w", pady=10)
        entry.bind("<Return>", lambda e: accept())

    def _session_ready(self, target, announce=False):
        """Hay sesion: se muestran los orgs/spaces reales del usuario."""
        if not target["logged"]:
            self.conn_var.set("Sin conectar.")
            return
        self.conn_var.set(f"Conectado como {target['user']}")
        if announce:
            self._say(f"OK  sesion de {target['user']}", "ok")
        if not self.user_var.get():
            self.user_var.set(target["user"])

        def work():
            targets = cf.list_targets()
            self._ui(lambda: self._fill_targets(targets, target))

        self._background(work)

    def _fill_targets(self, targets, current):
        self.targets = targets
        orgs = [t["org"] for t in targets]
        self.org_combo.configure(values=orgs)
        # Se respeta lo que traia el perfil; si no, lo que ya tenia el CLI.
        wanted = self.org_var.get() or current.get("org", "")
        self.org_var.set(wanted if wanted in orgs else (orgs[0] if orgs else ""))
        self._fill_spaces(prefer=self.space_var.get() or current.get("space", ""))
        self._say(f"{len(orgs)} org(s) accesibles.", "info")

    def _fill_spaces(self, prefer=""):
        entry = next((t for t in self.targets if t["org"] == self.org_var.get()), None)
        spaces = entry["spaces"] if entry else []
        self.space_combo.configure(values=spaces)
        self.space_var.set(prefer if prefer in spaces else (spaces[0] if spaces else ""))

    # -----------------------------------------------------------------
    # PASO 4 y 5 - Apuntar, desplegar si falta, y arrancar
    # -----------------------------------------------------------------
    def _start(self):
        if self.proxy_running:
            return
        org, space = self.org_var.get().strip(), self.space_var.get().strip()
        if not org or not space:
            messagebox.showwarning("Falta el destino",
                                   "Conectá primero y elegí org y space.", parent=self)
            return
        if not self.proxy_dir:
            messagebox.showerror("Falta cf-proxy",
                                 "No se encontró la carpeta recursos/cf-proxy.", parent=self)
            return

        # El proxy abre el tunel SSH antes de tomar el puerto: si el puerto ya
        # esta ocupado, falla a medias y deja un `cf ssh` colgado. Se avisa antes.
        port = self._proxy_port()
        if cf.port_in_use(port):
            messagebox.showwarning(
                "Puerto ocupado",
                f"Algo ya está escuchando en el puerto {port}. "
                "Puede ser otra instancia de cf-proxy. Cerrala, o elegí otro puerto.",
                parent=self)
            return

        self.start_btn.configure(state="disabled")
        self.status_var.set(f"Apuntando a {org}/{space}…")

        def work():
            ok, msg = cf.set_target(org, space)
            if not ok:
                self._say(msg, "err")
                self._ui(lambda: (self.status_var.set("No se pudo apuntar."),
                                  self.start_btn.configure(state="normal")))
                return
            self._say(f"OK  target: {org} / {space}", "ok")

            # Si falta la instancia, se ofrece desplegar el .mtar del paquete.
            if not cf.has_destination_instance():
                self._ui(self._offer_deploy)
                return
            self._launch_proxy()

        self._background(work)

    def _offer_deploy(self):
        if not self.mtar:
            self._say("Falta la instancia `cf-dest-destination` y no hay .mtar en el paquete.", "err")
            self.status_var.set("Falta desplegar los recursos.")
            self.start_btn.configure(state="normal")
            return

        answer = messagebox.askyesno(
            "Faltan recursos en este space",
            f"El space {self.org_var.get()} / {self.space_var.get()} no tiene la instancia "
            "`cf-dest-destination`, que cf-proxy necesita.\n\n"
            "¿Desplegarla ahora?\n\n"
            "Crea: cf-dest-destination, cf-dest-xsuaa, cf-dest-connectivity y la app "
            "cf-dest-app (para el túnel on-premise). Tarda unos minutos.\n\n"
            "Todo lleva el prefijo cf-dest- y se borra con `npm run undeploy`.",
            parent=self)

        if not answer:
            self.status_var.set("Cancelado: faltan recursos.")
            self.start_btn.configure(state="normal")
            return

        self.status_var.set("Desplegando recursos…")
        self._say(f"cf deploy {self.mtar.name} -f", "info")

        def work():
            ok = cf.deploy_mtar(self.mtar, self._say)
            if not ok:
                self._say("El deploy fallo. Ver la salida.", "err")
                self._ui(lambda: (self.status_var.set("Deploy fallido."),
                                  self.start_btn.configure(state="normal")))
                return
            self._say("OK  recursos desplegados.", "ok")
            self._launch_proxy()

        self._background(work)

    def _proxy_args(self):
        args = ["node", "server.js", "--port", str(int(self.port_var.get() or 3100))]
        if self.tunnel_var.get():
            args.append("--tunnel")
        if self.login_var.get():
            args.append("--login")
        if self.keys_var.get():
            args.append("--create-keys")
        # El launcher abre la pagina por su cuenta al detectar que esta escuchando.
        args.append("--no-open")
        return args

    def _launch_proxy(self):
        args = self._proxy_args()
        self._say("", None)
        self._say("> " + " ".join(args), "info")
        self.proxy_running = True
        self._ui(lambda: (self.stop_btn.configure(state="normal"),
                          self.status_var.set("cf-proxy corriendo…")))

        def on_line(line):
            self._say(line)
            # El proxy avisa cuando el puerto ya acepta conexiones.
            if "Escuchando en" in line:
                self._ui(lambda: self.open_btn.configure(state="normal"))
                if self.open_var.get():
                    self._open_page()

        def work():
            cf.stream(args, on_line, cwd=self.proxy_dir, key="proxy")
            self.proxy_running = False
            self._say("cf-proxy termino.", "info")
            self._ui(lambda: (self.start_btn.configure(state="normal"),
                              self.stop_btn.configure(state="disabled"),
                              self.open_btn.configure(state="disabled"),
                              self.status_var.set("Detenido.")))

        self.proxy_thread = threading.Thread(target=work, daemon=True)
        self.proxy_thread.start()

    def _stop(self):
        """
        Corta el proxy. Se mata el arbol entero: `node server.js` abre a su vez
        un `cf ssh` para el tunel, y matar solo al padre lo dejaria huerfano
        ocupando el puerto.
        """
        if not self.proxy_running:
            return
        self._say("Deteniendo cf-proxy…", "info")
        cf.kill_tree("proxy")
        self.stop_btn.configure(state="disabled")

    def _proxy_port(self):
        try:
            return int(self.port_var.get() or 3100)
        except ValueError:
            return 3100

    def _open_page(self):
        webbrowser.open(f"http://localhost:{self._proxy_port()}/")

    def _on_close(self):
        if self.proxy_running:
            if not messagebox.askyesno("cf-proxy está corriendo",
                                       "Se va a detener el proxy. ¿Cerrar?", parent=self):
                return
            cf.kill_tree("proxy")
        self.destroy()


def main():
    LauncherApp().mainloop()
