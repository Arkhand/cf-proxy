"""
PASO 3 - La ventana: consola de administracion y lanzamiento de cf-proxy.

Arriba, los PERFILES guardados (uno por subcuenta de cliente, cada uno con su
puerto). Abajo, una PESTANA por cada proxy corriendo, sin importar quien lo
lanzo: esta ventana, una terminal o una IA en otro chat. Las pestanas se
arman a partir de `cf-proxy ps` cada pocos segundos, asi que lo que se ve es
lo mismo que vera cualquier otra consola.

Lo que hace, en orden:

  1. Verifica que `cf` y `node` esten instalados. Sin eso no se puede seguir.
  2. Perfiles: alta y edicion (login con el CF_HOME del perfil para listar
     sus orgs/spaces reales), borrado, login.
  3. Iniciar: `cf-proxy start <perfil>`. Si el perfil no tiene sesion, pide
     login; si el space no tiene los recursos, ofrece desplegar el .mtar con
     el wrapper del perfil (nunca con la sesion global de `cf`).
  4. Cada corrida en su pestana: health, log en vivo, abrir pagina, detener,
     cerrar.

NO reemplaza nada del proxy: todo pasa por `node bin/cf-proxy.js` (cli.py),
el mismo programa que se usa desde la terminal.
"""
import queue
import threading
import tkinter as tk
import webbrowser
from tkinter import messagebox, ttk

from . import cf, store
from .cli import Cli, NO_RESOURCES, NO_SESSION, sso_passcode_url
from .paths import find_proxy_dir, find_mtar

PAD = {"padx": 8, "pady": 4}
POLL_MS = 3000
TAIL_MS = 1000
DEFAULT_API = "https://api.cf.us10-001.hana.ondemand.com"


class LauncherApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("cf-proxy")
        self.geometry("980x720")
        self.minsize(820, 580)

        # Cola de mensajes: los hilos de trabajo no tocan widgets directamente,
        # escriben aca y el hilo de la UI los consume (tkinter no es thread-safe).
        self.messages = queue.Queue()
        self.proxy_dir = find_proxy_dir()
        self.mtar = find_mtar()
        self.cli = Cli(self.proxy_dir) if self.proxy_dir else None

        self.profiles = []      # lo que devuelve `profiles list`
        self.running = {}       # perfil -> registro de `ps`
        self.tabs = {}          # perfil -> RunTab
        self.launched = set()   # perfiles iniciados desde ESTA ventana (para el cierre)
        self.polling = False

        self._build()
        self.after(100, self._drain)
        self.after(TAIL_MS, self._tail_all)
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
        root.rowconfigure(1, weight=1)

        self._build_profiles(root).grid(row=0, column=0, sticky="ew", pady=(0, 8))

        self.notebook = ttk.Notebook(root)
        self.notebook.grid(row=1, column=0, sticky="nsew")
        general = ttk.Frame(self.notebook, padding=4)
        general.columnconfigure(0, weight=1)
        general.rowconfigure(0, weight=1)
        self.log = make_log(general)
        self.notebook.add(general, text="  Launcher  ")

        self.status_var = tk.StringVar(value="Verificando requisitos…")
        ttk.Label(root, textvariable=self.status_var, foreground="#555").grid(
            row=2, column=0, sticky="w", pady=(6, 0))

    def _build_profiles(self, parent):
        box = ttk.LabelFrame(parent, text="Perfiles (uno por subcuenta)", padding=8)
        box.columnconfigure(0, weight=1)

        cols = ("title", "target", "port", "state")
        self.tree = ttk.Treeview(box, columns=cols, height=6, selectmode="browse")
        self.tree.heading("#0", text="Perfil")
        self.tree.heading("title", text="Título")
        self.tree.heading("target", text="Org / Space")
        self.tree.heading("port", text="Puerto")
        self.tree.heading("state", text="Estado")
        self.tree.column("#0", width=130)
        self.tree.column("title", width=160)
        self.tree.column("target", width=220)
        self.tree.column("port", width=60, anchor="center")
        self.tree.column("state", width=320)
        self.tree.tag_configure("problem", foreground="#c0392b")
        self.tree.tag_configure("running", foreground="#1e7e34")
        self.tree.grid(row=0, column=0, sticky="ew")
        self.tree.bind("<Double-1>", lambda e: self._edit())

        buttons = ttk.Frame(box)
        buttons.grid(row=0, column=1, sticky="n", padx=(8, 0))
        for text, cmd in (("Iniciar", self._start_selected), ("Login", self._login_selected),
                          ("Nuevo", self._new), ("Editar", self._edit), ("Borrar", self._delete)):
            ttk.Button(buttons, text=text, command=cmd, width=10).pack(fill="x", pady=2)
        return box

    # -----------------------------------------------------------------
    # Mensajes entre hilos
    # -----------------------------------------------------------------
    def _say(self, text, tag=None):
        """Escribe en el log general. Seguro desde cualquier hilo."""
        self.messages.put(("log", text, tag))

    def _drain(self):
        """Consume la cola en el hilo de la UI. tkinter no es thread-safe."""
        while True:
            try:
                kind, *rest = self.messages.get_nowait()
            except queue.Empty:
                break
            if kind == "log":
                write_log(self.log, rest[0], rest[1])
            elif kind == "call":
                rest[0]()
        self.after(100, self._drain)

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
                for m in missing:
                    self._say(f"Falta {m['tool']}: {m['hint']}", "err")
                self._ui(lambda: (self.status_var.set("Faltan requisitos. Ver la salida."),
                                  messagebox.showerror("Faltan requisitos", detail, parent=self)))
                return

            v = cf.versions()
            self._ui(lambda: self.status_var.set(f"cf {v['cf']}  ·  node {v['node']}  ·  listo."))
            self._say(f"cf {v['cf']} y node {v['node']} detectados.", "ok")

            if not self.cli:
                self._say("No se encontro la carpeta de cf-proxy junto al ejecutable.", "err")
                self._ui(lambda: self.status_var.set("Falta la carpeta recursos/cf-proxy."))
                return
            self._say(f"cf-proxy: {self.proxy_dir}", "info")
            self._refresh_profiles()
            self._ui(self._poll)

        self._background(work)

    # -----------------------------------------------------------------
    # PASO 2 - Perfiles
    # -----------------------------------------------------------------
    def _refresh_profiles(self):
        """Relee los perfiles desde la consola. Llamable desde cualquier hilo."""
        def work():
            res = self.cli.profiles()
            if not res.get("ok"):
                self._say(f"No se pudieron leer los perfiles: {res.get('error')}", "err")
                return
            self._ui(lambda: self._fill_profiles(res["profiles"]))

        self._background(work)

    def _fill_profiles(self, profiles):
        self.profiles = profiles
        selected = self.tree.selection()
        self.tree.delete(*self.tree.get_children())
        for p in profiles:
            self.tree.insert("", "end", iid=p["name"], text=p["name"], values=self._profile_row(p),
                             tags=self._profile_tags(p))
        if selected and self.tree.exists(selected[0]):
            self.tree.selection_set(selected[0])
        elif profiles:
            self.tree.selection_set(profiles[0]["name"])

    def _profile_row(self, p):
        target = f"{p['org']} / {p['space']}" if p["org"] else "(sin org: falta login)"
        run = self.running.get(p["name"])
        if run:
            state = f"corriendo ({run['status']})  {run['url']}"
            login = run.get("login")
            if login and login["configured"] and not login["loggedIn"]:
                state += "  ·  falta login de usuario"
        elif p["problems"]:
            state = "; ".join(p["problems"])
        else:
            state = "listo"
        return (p["title"], target, p["port"], state)

    def _profile_tags(self, p):
        if p["name"] in self.running:
            return ("running",)
        return ("problem",) if p["problems"] else ()

    def _update_profile_rows(self):
        for p in self.profiles:
            if self.tree.exists(p["name"]):
                self.tree.item(p["name"], values=self._profile_row(p), tags=self._profile_tags(p))

    def _selected(self):
        sel = self.tree.selection()
        return next((p for p in self.profiles if sel and p["name"] == sel[0]), None)

    def _new(self):
        ProfileEditor(self, None)

    def _edit(self):
        p = self._selected()
        if p:
            ProfileEditor(self, p)

    def _delete(self):
        p = self._selected()
        if not p:
            return
        if not messagebox.askyesno(
                "Borrar perfil",
                f"Se borra el perfil `{p['name']}`, su sesión de cf y su contraseña guardada.\n\n¿Seguir?",
                parent=self):
            return

        def work():
            res = self.cli.remove_profile(p["name"])
            if not res.get("ok"):
                self._say(res.get("error"), "err")
                return
            store.set_password(p["name"], "")
            self._say(f"Perfil `{p['name']}` borrado.", "info")
            self._refresh_profiles()

        self._background(work)

    # -----------------------------------------------------------------
    # Login: siempre en el CF_HOME del perfil, nunca en el `cf` global
    # -----------------------------------------------------------------
    def _login_selected(self):
        p = self._selected()
        if p:
            self.login(p)

    def login(self, p, password=None, then=None, on_fail=None):
        """
        Loguea el perfil. Con password: la guardada o la que se pase (si no hay,
        se pide). Con SSO: se abre el browser y se pide el passcode.
        `then` corre en el hilo de la UI si el login sale bien; `on_fail`, si
        falla o se cancela (con el motivo).
        """
        def failed(reason):
            if on_fail:
                self._ui(lambda: on_fail(reason))

        if p["auth"] == "sso":
            url = sso_passcode_url(p["api"])
            self._say(f"Abriendo {url} para el passcode.", "info")
            webbrowser.open(url)
            code = ask_secret(self, "Passcode SSO", f"Copiá el passcode temporal de\n{url}\ny pegalo acá:")
            if not code:
                failed("Login cancelado.")
                return
            call = lambda: self.cli.login_sso(p["name"], code)
        else:
            pw = password or store.get_password(p["name"]) or ask_secret(
                self, "Contraseña", f"Contraseña de {p['user'] or 'el usuario'} para {p['name']}:")
            if not pw:
                failed("Login cancelado.")
                return
            call = lambda: self.cli.login_password(p["name"], pw)

        self.status_var.set(f"Login de {p['name']}…")

        def work():
            res = call()
            if not res.get("ok"):
                self._say(f"Login de {p['name']} falló: {res.get('error')}", "err")
                self._ui(lambda: self.status_var.set("Login fallido."))
                failed(res.get("error") or "Login fallido.")
                return
            self._say(f"OK  {p['name']}: {res.get('user')} -> {res.get('org') or '?'} / {res.get('space') or '?'}", "ok")
            if res.get("warning"):
                # La sesion quedo, pero el org del perfil no existe: hay que corregirlo.
                self._say(res["warning"], "err")
            self._ui(lambda: self.status_var.set(f"{p['name']}: sesión OK."))
            if then:
                self._ui(then)

        self._background(work)

    # -----------------------------------------------------------------
    # PASO 3 - Iniciar
    # -----------------------------------------------------------------
    def _start_selected(self):
        p = self._selected()
        if p:
            self.start(p)

    def start(self, p):
        if p["problems"]:
            messagebox.showwarning("Perfil incompleto",
                                   f"{p['name']} no puede arrancar:\n\n" + "\n".join(p["problems"]), parent=self)
            return
        self.status_var.set(f"Iniciando {p['name']}…")
        self._say(f"> cf-proxy start {p['name']}", "info")

        def work():
            res = self.cli.start(p["name"])
            if res.get("ok"):
                self.launched.add(p["name"])
                verb = "ya estaba corriendo" if res.get("already") else "corriendo"
                self._say(f"OK  {p['name']} {verb} en {res['url']}", "ok")
                self._ui(lambda: self.status_var.set(f"{p['name']}: {res['url']}"))
                if p["flags"].get("open_browser") and not res.get("already"):
                    webbrowser.open(res["url"])
                self._ui(self._poll_now)
                return

            code = res.get("code")
            if res.get("tail"):
                for line in res["tail"].splitlines():
                    self._say("  " + line)
            if code == NO_SESSION:
                self._say(f"{p['name']} no tiene sesión de cf: hace falta login.", "info")
                self._ui(lambda: self.login(p, then=lambda: self.start(p)))
            elif code == NO_RESOURCES:
                self._ui(lambda: self._offer_deploy(p))
            else:
                self._say(f"No arrancó {p['name']}: {res.get('error')}", "err")
                self._ui(lambda: self.status_var.set(f"{p['name']}: no arrancó."))

        self._background(work)

    def _offer_deploy(self, p):
        if not self.mtar:
            self._say("Falta la instancia `cf-dest-destination` y no hay .mtar en el paquete.", "err")
            return
        if not messagebox.askyesno(
                "Faltan recursos en este space",
                f"El space {p['org']} / {p['space']} (perfil {p['name']}) no tiene la instancia "
                "`cf-dest-destination`, que cf-proxy necesita.\n\n"
                "¿Desplegarla ahora?\n\n"
                "Crea: cf-dest-destination, cf-dest-xsuaa, cf-dest-connectivity y la app "
                "cf-dest-app (para el túnel on-premise). Tarda unos minutos.\n\n"
                f"Se despliega con la sesión del perfil, en {p['org']} / {p['space']}. "
                f"Se borra con: cf-proxy cf {p['name']} -- undeploy cf-dest --delete-services -f",
                parent=self):
            return

        self.status_var.set(f"Desplegando recursos en {p['org']} / {p['space']}…")
        self._say(f"> cf-proxy cf {p['name']} -- deploy {self.mtar.name} -f", "info")

        def work():
            if not self.cli.run_cf(p["name"], ["deploy", str(self.mtar), "-f"], self._say):
                self._say("El deploy falló. Ver la salida.", "err")
                self._ui(lambda: self.status_var.set("Deploy fallido."))
                return
            self._say("OK  recursos desplegados.", "ok")
            self._ui(lambda: self.start(p))

        self._background(work)

    # -----------------------------------------------------------------
    # PASO 4 - Corridas: una pestana por proxy vivo, de cualquier origen
    # -----------------------------------------------------------------
    def _poll(self):
        """Consulta `ps` y reprograma. Las corridas de consola aparecen solas."""
        self._poll_now()
        self.after(POLL_MS, self._poll)

    def _poll_now(self):
        if self.polling or not self.cli:
            return
        self.polling = True

        def work():
            res = self.cli.ps()
            self._ui(lambda: self._apply_runs(res))

        self._background(work)

    def _apply_runs(self, res):
        self.polling = False
        if not res.get("ok"):
            return
        self.running = {r["profile"]: r for r in res["runs"]}

        for name, run in self.running.items():
            tab = self.tabs.get(name)
            if not tab:
                tab = RunTab(self, run)
                self.tabs[name] = tab
                self.notebook.add(tab, text=f"  {run.get('title') or name}  ")
            tab.update_run(run)

        # Las que ya no corren quedan como "detenido" hasta que se cierren.
        for name, tab in self.tabs.items():
            if name not in self.running:
                tab.mark_stopped()

        self._update_profile_rows()

    def _tail_all(self):
        for tab in list(self.tabs.values()):
            tab.tail()
        self.after(TAIL_MS, self._tail_all)

    def stop(self, name, then=None):
        self._say(f"> cf-proxy stop {name}", "info")

        def work():
            res = self.cli.stop(name)
            if not res.get("ok"):
                self._say(f"No se pudo detener {name}: {res.get('error')}", "err")
            self.launched.discard(name)
            self._ui(self._poll_now)
            if then:
                self._ui(then)

        self._background(work)

    def close_tab(self, name):
        """Cerrar la pestana detiene la corrida (si sigue viva) y la saca."""
        def remove():
            tab = self.tabs.pop(name, None)
            if tab:
                self.notebook.forget(tab)
                tab.destroy()

        if name in self.running:
            if not messagebox.askyesno("Cerrar pestaña", f"Se detiene {name}. ¿Seguir?", parent=self):
                return
            self.stop(name, then=remove)
        else:
            remove()

    def _on_close(self):
        """
        Pregunta solo por lo que lanzo ESTA ventana. Lo que se arranco desde una
        terminal o desde otra sesion sigue corriendo: no es de esta ventana.
        """
        mine = sorted(n for n in self.launched if n in self.running)
        if mine:
            answer = messagebox.askyesnocancel(
                "Hay proxies corriendo",
                "Esta ventana inició: " + ", ".join(mine) + ".\n\n"
                "Sí: detenerlos y cerrar.\nNo: cerrar y dejarlos corriendo.\nCancelar: no cerrar.",
                parent=self)
            if answer is None:
                return
            if answer:
                for name in mine:
                    self.cli.stop(name)
        self.destroy()


class RunTab(ttk.Frame):
    """Una corrida: cabecera con su estado, botones, y el log en vivo."""

    def __init__(self, app, run):
        super().__init__(app.notebook, padding=6)
        self.app = app
        self.name = run["profile"]
        self.run = run
        self.log_path = run.get("log")
        self.offset = 0

        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        head = ttk.Frame(self)
        head.grid(row=0, column=0, sticky="ew", pady=(0, 6))
        head.columnconfigure(0, weight=1)
        self.info_var = tk.StringVar()
        self.state_var = tk.StringVar()
        ttk.Label(head, textvariable=self.info_var).grid(row=0, column=0, sticky="w")
        self.state_label = ttk.Label(head, textvariable=self.state_var)
        self.state_label.grid(row=1, column=0, sticky="w")
        # Login de usuario (XSUAA): sin el, las destinations PrincipalPropagation
        # y OAuth2UserTokenExchange fallan. Se avisa aca antes de que pase.
        self.login_var = tk.StringVar()
        self.login_label = ttk.Label(head, textvariable=self.login_var, wraplength=620)
        self.login_label.grid(row=2, column=0, sticky="w")

        self.open_btn = ttk.Button(head, text="Abrir página", command=lambda: webbrowser.open(self.run["url"]))
        self.open_btn.grid(row=0, column=1, rowspan=3, padx=(8, 0))
        self.login_btn = ttk.Button(head, text="Login de usuario", command=self._user_login)
        self.login_btn.grid(row=0, column=2, rowspan=3, padx=(8, 0))
        self.stop_btn = ttk.Button(head, text="Detener", command=lambda: app.stop(self.name))
        self.stop_btn.grid(row=0, column=3, rowspan=3, padx=(8, 0))
        ttk.Button(head, text="Cerrar pestaña", command=lambda: app.close_tab(self.name)).grid(
            row=0, column=4, rowspan=3, padx=(8, 0))

        body = ttk.Frame(self)
        body.grid(row=1, column=0, sticky="nsew")
        body.columnconfigure(0, weight=1)
        body.rowconfigure(0, weight=1)
        self.text = make_log(body)
        if not self.log_path:
            write_log(self.text, "Esta corrida se lanzó en primer plano: su salida está en esa terminal.", "info")

    def update_run(self, run):
        # Un registro nuevo (otro pid) es otra corrida: el log se relee desde cero.
        if run["pid"] != self.run.get("pid") or run.get("log") != self.log_path:
            self.log_path = run.get("log")
            self.offset = 0
            clear_log(self.text)
        self.run = run
        origin = {"ui": "ventana", "cli": "consola"}.get(run.get("origin"), run.get("origin") or "?")
        self.info_var.set(f"{run.get('title') or self.name}  ·  {run.get('user') or '?'}  ·  "
                          f"{run['org']} / {run['space']}  ·  puerto {run['port']}  ·  pid {run['pid']}  ·  lanzado desde {origin}")
        extra = ""
        if run.get("onPremise") is not None:
            extra = "on-premise: " + ("sí" if run["onPremise"] else "no")
        self.state_var.set(f"Estado: {run['status']}   {run['url']}   {extra}")
        self.state_label.configure(foreground="#1e7e34" if run["status"] == "ok" else "#b8860b")
        self.open_btn.configure(state="normal")
        self.stop_btn.configure(state="normal")
        self._show_login(run.get("login"))

    def _show_login(self, login):
        """Linea y boton del login de usuario segun lo que reporta `ps`."""
        if login is None:
            self.login_var.set("Login de usuario: esperando que el proxy responda…")
            self.login_label.configure(foreground="#555")
            self.login_btn.configure(state="disabled")
            return
        if not login["configured"]:
            self.login_var.set(f"Login de usuario: no disponible. {login.get('warning') or ''}")
            self.login_label.configure(foreground="#555")
            self.login_btn.configure(state="disabled")
            return
        if login["loggedIn"]:
            self.login_var.set(f"Login de usuario: {login.get('user') or 'OK'} (vence {login.get('expiresAt') or '?'}; se renueva solo)")
            self.login_label.configure(foreground="#1e7e34")
            self.login_btn.configure(state="normal")
            return
        text = ("Login de usuario: FALTA. Sin él fallan las destinations PrincipalPropagation "
                "y OAuth2UserTokenExchange.")
        if login.get("warning"):
            text += "  ⚠ " + login["warning"]
        self.login_var.set(text)
        self.login_label.configure(foreground="#c0392b")
        self.login_btn.configure(state="normal")

    def _user_login(self):
        """Abre /__login del proxy. Si el puerto no esta en las redirect-uris, avisa que va a fallar."""
        login = self.run.get("login") or {}
        if login.get("warning") and not messagebox.askyesno(
                "El login va a fallar",
                login["warning"] + "\n\nHay que agregar el puerto en xs-security.json y actualizar el "
                f"cf-dest-xsuaa de {self.run['org']}.\n\n¿Abrir el login igual?", parent=self):
            return
        webbrowser.open(login.get("url") or f"http://localhost:{self.run['port']}/__login")

    def mark_stopped(self):
        self.state_var.set("Estado: detenido")
        self.state_label.configure(foreground="#c0392b")
        self.open_btn.configure(state="disabled")
        self.stop_btn.configure(state="disabled")
        self.login_btn.configure(state="disabled")
        self.login_var.set("")

    def tail(self):
        """Agrega al Text lo nuevo del archivo de log. Si se trunco (nuevo start), arranca de cero."""
        if not self.log_path:
            return
        try:
            with open(self.log_path, "rb") as f:
                f.seek(0, 2)
                size = f.tell()
                if size < self.offset:
                    self.offset = 0
                    clear_log(self.text)
                if size == self.offset:
                    return
                f.seek(self.offset)
                chunk = f.read(size - self.offset)
                self.offset = size
        except OSError:
            return
        for line in chunk.decode("utf-8", errors="replace").splitlines():
            write_log(self.text, line)


class ProfileEditor(tk.Toplevel):
    """
    Alta y edicion de un perfil.

    Para un perfil nuevo el orden es: datos de la cuenta -> "Conectar"
    (guarda un borrador, loguea con SU CF_HOME y lista los orgs/spaces que ve
    ese usuario) -> elegir org/space -> Guardar. El nombre no se cambia
    despues: es la clave de su sesion de cf y de su contrasena guardada.
    """

    def __init__(self, app, profile):
        super().__init__(app)
        self.app = app
        self.editing = profile is not None
        p = profile or {"name": "", "title": "", "api": DEFAULT_API, "user": "", "auth": "sso",
                        "org": "", "space": "", "port": "", "flags": {"open_browser": True}}
        self.title(f"Perfil {p['name']}" if self.editing else "Perfil nuevo")
        self.transient(app)
        self.resizable(False, False)
        self.targets = []

        box = ttk.Frame(self, padding=10)
        box.pack(fill="both", expand=True)
        box.columnconfigure(1, weight=1)

        self.vars = {k: tk.StringVar(value=str(p.get(k) or "")) for k in ("name", "title", "api", "user", "org", "space", "port")}
        row = 0

        def field(label, key, **kw):
            nonlocal row
            ttk.Label(box, text=label).grid(row=row, column=0, sticky="w", **PAD)
            entry = ttk.Entry(box, textvariable=self.vars[key], width=46, **kw)
            entry.grid(row=row, column=1, columnspan=2, sticky="ew", **PAD)
            row += 1
            return entry

        field("Nombre", "name", state="disabled" if self.editing else "normal")
        field("Título", "title")
        field("API endpoint", "api")
        field("Usuario", "user")

        self.auth_var = tk.StringVar(value=p["auth"])
        methods = ttk.Frame(box)
        methods.grid(row=row, column=1, columnspan=2, sticky="w", **PAD)
        ttk.Label(box, text="Login").grid(row=row, column=0, sticky="w", **PAD)
        ttk.Radiobutton(methods, text="SSO (passcode del browser)", value="sso", variable=self.auth_var,
                        command=self._toggle_auth).pack(side="left")
        ttk.Radiobutton(methods, text="Contraseña", value="password", variable=self.auth_var,
                        command=self._toggle_auth).pack(side="left", padx=(12, 0))
        row += 1

        ttk.Label(box, text="Contraseña").grid(row=row, column=0, sticky="w", **PAD)
        self.pass_var = tk.StringVar(value=store.get_password(p["name"]) if p["name"] else "")
        self.pass_entry = ttk.Entry(box, textvariable=self.pass_var, show="•")
        self.pass_entry.grid(row=row, column=1, sticky="ew", **PAD)
        self.remember_var = tk.BooleanVar(value=True)
        self.remember_check = ttk.Checkbutton(box, text="Recordar", variable=self.remember_var)
        self.remember_check.grid(row=row, column=2, sticky="w", **PAD)
        row += 1

        ttk.Button(box, text="Conectar y listar orgs", command=self._connect).grid(row=row, column=1, sticky="w", **PAD)
        self.conn_var = tk.StringVar(value="")
        ttk.Label(box, textvariable=self.conn_var, foreground="#555").grid(row=row, column=2, sticky="w", **PAD)
        row += 1

        ttk.Label(box, text="Org").grid(row=row, column=0, sticky="w", **PAD)
        self.org_combo = ttk.Combobox(box, textvariable=self.vars["org"], state="readonly",
                                      values=[p["org"]] if p["org"] else [])
        self.org_combo.grid(row=row, column=1, columnspan=2, sticky="ew", **PAD)
        self.org_combo.bind("<<ComboboxSelected>>", lambda e: self._fill_spaces())
        row += 1

        ttk.Label(box, text="Space").grid(row=row, column=0, sticky="w", **PAD)
        self.space_combo = ttk.Combobox(box, textvariable=self.vars["space"], state="readonly",
                                        values=[p["space"]] if p["space"] else [])
        self.space_combo.grid(row=row, column=1, columnspan=2, sticky="ew", **PAD)
        row += 1

        ttk.Label(box, text="Puerto").grid(row=row, column=0, sticky="w", **PAD)
        ttk.Entry(box, textvariable=self.vars["port"], width=8).grid(row=row, column=1, sticky="w", **PAD)
        ttk.Label(box, text="vacío = el siguiente libre", foreground="#555").grid(row=row, column=2, sticky="w", **PAD)
        row += 1

        flags = p.get("flags") or {}
        self.flag_vars = {k: tk.BooleanVar(value=bool(flags.get(k))) for k in ("tunnel", "login", "create_keys", "open_browser")}
        fbox = ttk.Frame(box)
        fbox.grid(row=row, column=0, columnspan=3, sticky="w", **PAD)
        for key, text in (("tunnel", "Forzar túnel SSH"), ("login", "Abrir login de usuario"),
                          ("create_keys", "Permitir crear service keys"), ("open_browser", "Abrir la página al arrancar")):
            ttk.Checkbutton(fbox, text=text, variable=self.flag_vars[key]).pack(side="left", padx=(0, 12))
        row += 1

        actions = ttk.Frame(box)
        actions.grid(row=row, column=0, columnspan=3, sticky="e", pady=(10, 0))
        ttk.Button(actions, text="Guardar", command=self._save).pack(side="left")
        ttk.Button(actions, text="Cancelar", command=self.destroy).pack(side="left", padx=(8, 0))

        self._toggle_auth()
        self.grab_set()

    def _toggle_auth(self):
        """Con SSO no hay contrasena que escribir ni que recordar."""
        state = "normal" if self.auth_var.get() == "password" else "disabled"
        self.pass_entry.configure(state=state)
        self.remember_check.configure(state=state)

    def _data(self):
        port = self.vars["port"].get().strip()
        return {
            "name": self.vars["name"].get().strip(),
            "title": self.vars["title"].get().strip() or self.vars["name"].get().strip(),
            "api": self.vars["api"].get().strip(),
            "user": self.vars["user"].get().strip(),
            "auth": self.auth_var.get(),
            "org": self.vars["org"].get().strip(),
            "space": self.vars["space"].get().strip(),
            "port": int(port) if port.isdigit() else "auto",
            "flags": {k: v.get() for k, v in self.flag_vars.items()},
        }

    def _persist(self, data):
        """Guarda por la consola. Devuelve el perfil guardado o None (y avisa)."""
        res = self.app.cli.save_profile(data)
        if not res.get("ok"):
            messagebox.showerror("No se pudo guardar", res.get("error"), parent=self)
            return None
        p = res["profile"]
        self.vars["port"].set(str(p["port"]))
        if p["auth"] == "password" and self.remember_var.get():
            store.set_password(p["name"], self.pass_var.get())
        else:
            store.set_password(p["name"], "")
        return p

    def _connect(self):
        """Guarda (aunque sea borrador), loguea con el CF_HOME del perfil y lista sus orgs."""
        data = self._data()
        if not data["name"] or not data["api"]:
            messagebox.showwarning("Faltan datos", "Nombre y API endpoint.", parent=self)
            return
        p = self._persist(data)
        if not p:
            return
        self.vars["name"].set(p["name"])
        self.conn_var.set("Conectando…")
        p = {**p, "problems": []}
        self.app.login(p, password=self.pass_var.get() or None, then=lambda: self._load_targets(p["name"]),
                       on_fail=lambda reason: self.winfo_exists() and self.conn_var.set(reason[:60]))
        self.app._refresh_profiles()

    def _load_targets(self, name):
        self.conn_var.set("Listando orgs…")

        def work():
            res = self.app.cli.targets(name)
            self.app._ui(lambda: self._fill_targets(res))

        self.app._background(work)

    def _fill_targets(self, res):
        if not self.winfo_exists():
            return
        if not res.get("ok"):
            self.conn_var.set("No se pudieron listar los orgs.")
            self.app._say(res.get("error"), "err")
            return
        self.targets = res["targets"]
        orgs = [t["org"] for t in self.targets]
        self.org_combo.configure(values=orgs)
        current = res.get("current") or {}
        wanted = self.vars["org"].get() or current.get("org", "")
        self.vars["org"].set(wanted if wanted in orgs else (orgs[0] if orgs else ""))
        self._fill_spaces(prefer=self.vars["space"].get() or current.get("space", ""))
        self.conn_var.set(f"Conectado. {len(orgs)} org(s).")

    def _fill_spaces(self, prefer=""):
        entry = next((t for t in self.targets if t["org"] == self.vars["org"].get()), None)
        spaces = entry["spaces"] if entry else []
        self.space_combo.configure(values=spaces)
        self.vars["space"].set(prefer if prefer in spaces else (spaces[0] if spaces else ""))

    def _save(self):
        data = self._data()
        if not data["name"]:
            messagebox.showwarning("Falta el nombre", "Indicá un nombre para el perfil.", parent=self)
            return
        p = self._persist(data)
        if not p:
            return
        self.app._say(f"Perfil `{p['name']}` guardado (puerto {p['port']}).", "ok")
        self.app._refresh_profiles()
        self.destroy()


# ---------------------------------------------------------------------------
# Utilidades de widgets
# ---------------------------------------------------------------------------
def make_log(parent):
    """Text de solo lectura con scroll y colores por tipo de linea."""
    text = tk.Text(parent, wrap="none", height=14, state="disabled",
                   background="#1e1e1e", foreground="#d4d4d4",
                   insertbackground="#d4d4d4", font=("Consolas", 9))
    text.grid(row=0, column=0, sticky="nsew")
    bar = ttk.Scrollbar(parent, orient="vertical", command=text.yview)
    bar.grid(row=0, column=1, sticky="ns")
    text.configure(yscrollcommand=bar.set)
    # Colores por tipo de linea, para que el error salte a la vista.
    text.tag_configure("err", foreground="#f48771")
    text.tag_configure("ok", foreground="#89d185")
    text.tag_configure("info", foreground="#9cdcfe")
    return text


def write_log(text, line, tag=None):
    if tag is None:
        low = line.lower()
        tag = "err" if ("error" in low or "fail" in low) else \
              "ok" if line.lstrip().startswith("OK") else None
    text.configure(state="normal")
    text.insert("end", line + "\n", tag or ())
    text.see("end")
    text.configure(state="disabled")


def clear_log(text):
    text.configure(state="normal")
    text.delete("1.0", "end")
    text.configure(state="disabled")


def ask_secret(parent, title, prompt):
    """Dialogo modal para una contrasena o passcode. Devuelve '' si se cancela."""
    win = tk.Toplevel(parent)
    win.title(title)
    win.transient(parent)
    win.resizable(False, False)
    var = tk.StringVar()
    ttk.Label(win, text=prompt, wraplength=380).grid(row=0, column=0, columnspan=2, sticky="w", padx=10, pady=(10, 6))
    entry = ttk.Entry(win, textvariable=var, width=40, show="•")
    entry.grid(row=1, column=0, columnspan=2, sticky="ew", padx=10, pady=4)
    entry.focus_set()
    result = {"value": ""}

    def accept():
        result["value"] = var.get().strip()
        win.destroy()

    ttk.Button(win, text="Aceptar", command=accept).grid(row=2, column=0, sticky="e", padx=10, pady=10)
    ttk.Button(win, text="Cancelar", command=win.destroy).grid(row=2, column=1, sticky="w", pady=10)
    entry.bind("<Return>", lambda e: accept())
    win.grab_set()
    parent.wait_window(win)
    return result["value"]


def main():
    LauncherApp().mainloop()
