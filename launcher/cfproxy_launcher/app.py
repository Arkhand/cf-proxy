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
  5. Tuneles a servicios del space (p.ej. PostgreSQL): alta, edicion, borrado,
     iniciar y detener. Su estado sale del mismo `ps`.

NO reemplaza nada del proxy: todo pasa por `node bin/cf-proxy.js` (cli.py),
el mismo programa que se usa desde la terminal.
"""
import queue
import threading
import tkinter as tk
import webbrowser
from tkinter import messagebox, ttk

from . import cf, store, theme
from .cli import Cli, NO_RESOURCES, NO_SESSION, sso_passcode_url
from .paths import find_icon, find_proxy_dir, find_mtar
from .theme import px

PAD = {"padx": 8, "pady": 4}
POLL_MS = 3000
TAIL_MS = 1000
DEFAULT_API = "https://api.cf.us10-001.hana.ondemand.com"


class LauncherApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("cf-proxy")
        self.fonts = theme.apply(self)
        self.geometry(f"{px(1040)}x{px(820)}")
        self.minsize(px(860), px(600))
        # Un punto por estado, para filas y pestanas.
        self.dots = {k: theme.dot(self, c) for k, c in
                     (("ok", theme.OK), ("warn", theme.WARN), ("err", theme.ERR), ("idle", theme.IDLE))}
        # El mismo icono del .exe; `default` lo hereda cada dialogo.
        icon = find_icon()
        if icon:
            self.iconbitmap(default=str(icon))

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
        self.tunnels = []               # lo que devuelve `tunnels list`
        self.tunnel_runs = {}           # tunel -> registro de `ps`
        self.launched_tunnels = set()   # tuneles iniciados desde ESTA ventana
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
        root = ttk.Frame(self, padding=(px(16), px(12), px(16), px(8)))
        root.pack(fill="both", expand=True)
        root.columnconfigure(0, weight=1)
        root.rowconfigure(1, weight=1)

        head = ttk.Frame(root)
        head.grid(row=0, column=0, sticky="ew", pady=(0, px(10)))
        ttk.Label(head, text="cf-proxy", style="Title.TLabel").pack(side="left")
        ttk.Label(head, text="Proxy local a las destinations de SAP BTP", style="Muted.TLabel").pack(
            side="left", padx=(px(10), 0), pady=(px(5), 0))

        # Tablas arriba y pestanas abajo, con un divisor que se puede arrastrar:
        # el log necesita espacio cuando algo falla, las tablas cuando hay muchos perfiles.
        panes = ttk.Panedwindow(root, orient="vertical")
        panes.grid(row=1, column=0, sticky="nsew")
        top = ttk.Frame(panes)
        top.columnconfigure(0, weight=1)
        self._build_profiles(top).grid(row=0, column=0, sticky="ew", pady=(0, px(14)))
        self._build_tunnels(top).grid(row=1, column=0, sticky="ew", pady=(0, px(6)))
        panes.add(top, weight=0)

        self.notebook = ttk.Notebook(panes)
        general = ttk.Frame(self.notebook, padding=0)
        general.columnconfigure(0, weight=1)
        general.rowconfigure(0, weight=1)
        self.log = make_log(general)
        self.notebook.add(general, text="Actividad")
        panes.add(self.notebook, weight=1)

        ttk.Separator(root).grid(row=2, column=0, sticky="ew", pady=(px(8), px(6)))
        bar = ttk.Frame(root)
        bar.grid(row=3, column=0, sticky="ew")
        self.busy = ttk.Progressbar(bar, mode="indeterminate", length=px(90), style="Busy.Horizontal.TProgressbar")
        self.status_var = tk.StringVar()
        ttk.Label(bar, textvariable=self.status_var, style="Muted.TLabel").pack(side="left")
        # Todo mensaje de estado que termina en "…" es trabajo en curso: se
        # muestra la barra animada sin tener que avisarla en cada llamada.
        self.status_var.trace_add("write", lambda *_: self._show_busy(self.status_var.get().endswith("…")))
        self.status_var.set("Verificando requisitos…")

    def _show_busy(self, on):
        if on:
            self.busy.pack(side="right")
            self.busy.start(12)
        else:
            self.busy.stop()
            self.busy.pack_forget()

    def _build_profiles(self, parent):
        box = ttk.Frame(parent)
        box.columnconfigure(0, weight=1)

        head = ttk.Frame(box)
        head.grid(row=0, column=0, sticky="ew", pady=(0, px(6)))
        ttk.Label(head, text="Perfiles", style="Section.TLabel").pack(side="left")
        ttk.Label(head, text="uno por subcuenta", style="Hint.TLabel").pack(side="left", padx=(px(8), 0), pady=(px(3), 0))
        self.profile_buttons = toolbar(head, (
            ("toggle", "▶  Iniciar", self._toggle_selected, "Accent.TButton"),
            ("login", "Login", self._login_selected, None),
            ("|",),
            ("new", "+  Nuevo", self._new, None),
            ("edit", "Editar", self._edit, None),
            ("delete", "Borrar", self._delete, None),
        ))

        cols = ("title", "target", "port", "state")
        self.tree = make_tree(box, cols, height=6, widths={
            "#0": ("Perfil", 150), "title": ("Título", 170), "target": ("Org / Space", 250),
            "port": ("Puerto", 70), "state": ("Estado", 320)})
        self.tree.bind("<Double-1>", lambda e: self._edit())
        self.tree.bind("<Return>", lambda e: self._toggle_selected())
        self.tree.bind("<Delete>", lambda e: self._delete())
        self.tree.bind("<<TreeviewSelect>>", lambda e: self._sync_profile_buttons())
        self.tree.bind("<Button-3>", self._profile_menu)
        self.profiles_empty = empty_hint(self.tree, "Todavía no hay perfiles. Tocá «+ Nuevo» para crear el primero.")
        return box

    def _build_tunnels(self, parent):
        box = ttk.Frame(parent)
        box.columnconfigure(0, weight=1)

        head = ttk.Frame(box)
        head.grid(row=0, column=0, sticky="ew", pady=(0, px(6)))
        ttk.Label(head, text="Túneles", style="Section.TLabel").pack(side="left")
        ttk.Label(head, text="a servicios del space, p.ej. PostgreSQL", style="Hint.TLabel").pack(
            side="left", padx=(px(8), 0), pady=(px(3), 0))
        self.tunnel_buttons = toolbar(head, (
            ("toggle", "▶  Iniciar", self._toggle_tunnel, "Accent.TButton"),
            ("|",),
            ("new", "+  Nuevo", self._new_tunnel, None),
            ("edit", "Editar", self._edit_tunnel, None),
            ("delete", "Borrar", self._delete_tunnel, None),
        ))

        cols = ("profile", "service", "local", "remote", "state")
        self.tunnel_tree = make_tree(box, cols, height=3, widths={
            "#0": ("Túnel", 150), "profile": ("Perfil", 110), "service": ("Instancia", 190),
            "local": ("Local", 120), "remote": ("Remoto (vía app)", 240), "state": ("Estado", 150)})
        self.tunnel_tree.bind("<Double-1>", lambda e: self._edit_tunnel())
        self.tunnel_tree.bind("<Return>", lambda e: self._toggle_tunnel())
        self.tunnel_tree.bind("<Delete>", lambda e: self._delete_tunnel())
        self.tunnel_tree.bind("<<TreeviewSelect>>", lambda e: self._sync_tunnel_buttons())
        self.tunnel_tree.bind("<Button-3>", self._tunnel_menu)
        self.tunnels_empty = empty_hint(
            self.tunnel_tree, "Sin túneles. Sirven para llegar desde tu PC a una base de BTP (p.ej. para un CAP en modo hybrid).")
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
            self._refresh_tunnels()
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
        moved = store.migrate_legacy(profiles)
        if moved:
            self._say(f"{moved} contraseña(s) pasadas al Administrador de credenciales de Windows.", "ok")
        self.profiles = profiles
        selected = self.tree.selection()
        self.tree.delete(*self.tree.get_children())
        for i, p in enumerate(profiles):
            self.tree.insert("", "end", iid=p["name"], text=" " + p["name"], values=self._profile_row(p),
                             image=self.dots[self._profile_state(p)], tags=self._profile_tags(p, i))
        if selected and self.tree.exists(selected[0]):
            self.tree.selection_set(selected[0])
        elif profiles:
            self.tree.selection_set(profiles[0]["name"])
        show_empty(self.profiles_empty, not profiles)
        self._sync_profile_buttons()

    def _profile_row(self, p):
        target = f"{p['org']} / {p['space']}" if p["org"] else "(sin org: falta login)"
        run = self.running.get(p["name"])
        if run:
            state = "corriendo" if run["status"] == "ok" else f"corriendo ({run['status']})"
            state += f"  ·  {run['url']}"
            if self._missing_user_login(run):
                state += "  ·  falta login de usuario"
        elif p["problems"]:
            state = "; ".join(p["problems"])
        else:
            state = "listo"
        return (p["title"], target, p["port"], state)

    @staticmethod
    def _missing_user_login(run):
        login = run.get("login")
        return bool(login and login["configured"] and not login["loggedIn"])

    def _profile_state(self, p):
        """Color del punto: verde corriendo bien, ambar corriendo con algo pendiente, rojo con problemas."""
        run = self.running.get(p["name"])
        if run:
            return "ok" if run["status"] == "ok" and not self._missing_user_login(run) else "warn"
        return "err" if p["problems"] else "idle"

    def _profile_tags(self, p, i):
        tags = ["odd"] if i % 2 else []
        if p["problems"] and p["name"] not in self.running:
            tags.append("problem")
        return tags

    def _update_profile_rows(self):
        for i, p in enumerate(self.profiles):
            if self.tree.exists(p["name"]):
                self.tree.item(p["name"], values=self._profile_row(p), image=self.dots[self._profile_state(p)],
                               tags=self._profile_tags(p, i))
        self._sync_profile_buttons()

    def _selected(self):
        sel = self.tree.selection()
        return next((p for p in self.profiles if sel and p["name"] == sel[0]), None)

    def _sync_profile_buttons(self):
        """El boton principal es Iniciar o Detener segun la fila; sin fila, solo Nuevo."""
        p = self._selected()
        b = self.profile_buttons
        running = bool(p and p["name"] in self.running)
        b["toggle"].configure(text="■  Detener" if running else "▶  Iniciar")
        for key in ("toggle", "login", "edit", "delete"):
            b[key].configure(state="normal" if p else "disabled")

    def _toggle_selected(self):
        p = self._selected()
        if not p:
            return
        if p["name"] in self.running:
            self.stop(p["name"])
        else:
            self.start(p)

    def _profile_menu(self, event):
        """Clic derecho: las mismas acciones, mas abrir y copiar la URL si corre."""
        row = self.tree.identify_row(event.y)
        if not row:
            return
        self.tree.selection_set(row)
        self.tree.focus(row)
        p = self._selected()
        run = self.running.get(p["name"])
        menu = tk.Menu(self, tearoff=0)
        menu.add_command(label="Detener" if run else "Iniciar", command=self._toggle_selected)
        if run:
            menu.add_command(label="Abrir página", command=lambda: webbrowser.open(run["url"]))
            menu.add_command(label="Copiar URL", command=lambda: self.copy(run["url"]))
        menu.add_command(label="Login", command=self._login_selected)
        menu.add_separator()
        menu.add_command(label="Editar…", command=self._edit)
        menu.add_command(label="Borrar…", command=self._delete)
        menu.tk_popup(event.x_root, event.y_root)

    def copy(self, text):
        self.clipboard_clear()
        self.clipboard_append(text)
        self.status_var.set(f"Copiado: {text}")

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
                f"Se borra el perfil `{p['name']}`. La sesión de cf y la contraseña del usuario se mantienen (las comparte cf-target).\n\n¿Seguir?",
                parent=self):
            return

        def work():
            res = self.cli.remove_profile(p["name"])
            if not res.get("ok"):
                self._say(res.get("error"), "err")
                return
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

    def login(self, p, password=None, then=None, on_fail=None, remember=True):
        """
        Loguea el perfil. Con password: la guardada o la que se pase (si no hay,
        se pide). Con SSO: se abre el browser y se pide el passcode.
        `then` corre en el hilo de la UI si el login sale bien; `on_fail`, si
        falla o se cancela (con el motivo).

        Una contrasena tipeada se guarda recien cuando cf la acepto (y si
        `remember`): una mala guardada haria fallar cada corrida de cf-target y
        podria bloquear la cuenta en el IdP.
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
            stored = store.get_password(p["api"], p["user"])
            pw = password or stored or ask_secret(
                self, "Contraseña", f"Contraseña de {p['user'] or 'el usuario'} para {p['name']}:")
            if not pw:
                failed("Login cancelado.")
                return
            typed = pw != stored

            def call():
                res = self.cli.login_password(p["name"], pw)
                if res.get("ok") and typed and remember:
                    store.set_password(p["api"], p["user"], pw)
                return res

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
                self.notebook.add(tab, text=f" {run.get('title') or name}", image=self.dots["idle"], compound="left")
            tab.update_run(run)

        # Las que ya no corren quedan como "detenido" hasta que se cierren.
        for name, tab in self.tabs.items():
            if name not in self.running:
                tab.mark_stopped()

        self._update_profile_rows()
        self.tunnel_runs = {t["tunnel"]: t for t in res.get("tunnels", [])}
        self._update_tunnel_rows()

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
        mine_tunnels = sorted(n for n in self.launched_tunnels if n in self.tunnel_runs)
        if mine or mine_tunnels:
            names = mine + [f"túnel {n}" for n in mine_tunnels]
            answer = messagebox.askyesnocancel(
                "Hay proxies corriendo",
                "Esta ventana inició: " + ", ".join(names) + ".\n\n"
                "Sí: detenerlos y cerrar.\nNo: cerrar y dejarlos corriendo.\nCancelar: no cerrar.",
                parent=self)
            if answer is None:
                return
            if answer:
                for name in mine:
                    self.cli.stop(name)
                for name in mine_tunnels:
                    self.cli.stop_tunnel(name)
        self.destroy()

    # -----------------------------------------------------------------
    # PASO 5 - Tuneles a servicios del space
    # -----------------------------------------------------------------
    def _refresh_tunnels(self):
        """Relee los tuneles desde la consola. Llamable desde cualquier hilo."""
        def work():
            res = self.cli.tunnels()
            if not res.get("ok"):
                self._say(f"No se pudieron leer los túneles: {res.get('error')}", "err")
                return
            self._ui(lambda: self._fill_tunnels(res["tunnels"]))

        self._background(work)

    def _fill_tunnels(self, tunnels):
        self.tunnels = tunnels
        selected = self.tunnel_tree.selection()
        self.tunnel_tree.delete(*self.tunnel_tree.get_children())
        for i, t in enumerate(tunnels):
            self.tunnel_tree.insert("", "end", iid=t["name"], text=" " + t["name"], values=self._tunnel_row(t),
                                    image=self.dots[self._tunnel_state(t)], tags=self._tunnel_tags(t, i))
        if selected and self.tunnel_tree.exists(selected[0]):
            self.tunnel_tree.selection_set(selected[0])
        elif tunnels:
            self.tunnel_tree.selection_set(tunnels[0]["name"])
        show_empty(self.tunnels_empty, not tunnels)
        self._sync_tunnel_buttons()

    def _tunnel_row(self, t):
        run = self.tunnel_runs.get(t["name"])
        if run:
            remote = f"{run.get('remote') or '?'}  (vía {run.get('app') or '?'})"
            state = "corriendo" if run["status"] == "ok" else f"corriendo ({run['status']})"
        else:
            remote = f"(vía {t['app']})" if t["app"] else ""
            state = "; ".join(t["problems"]) if t["problems"] else "detenido"
        return (t["profile"], t["service"], f"localhost:{t['port']}", remote, state)

    def _tunnel_state(self, t):
        run = self.tunnel_runs.get(t["name"])
        if run:
            return "ok" if run["status"] == "ok" else "warn"
        return "err" if t["problems"] else "idle"

    def _tunnel_tags(self, t, i):
        tags = ["odd"] if i % 2 else []
        if t["problems"] and t["name"] not in self.tunnel_runs:
            tags.append("problem")
        return tags

    def _update_tunnel_rows(self):
        for i, t in enumerate(self.tunnels):
            if self.tunnel_tree.exists(t["name"]):
                self.tunnel_tree.item(t["name"], values=self._tunnel_row(t), image=self.dots[self._tunnel_state(t)],
                                      tags=self._tunnel_tags(t, i))
        self._sync_tunnel_buttons()

    def _selected_tunnel(self):
        sel = self.tunnel_tree.selection()
        return next((t for t in self.tunnels if sel and t["name"] == sel[0]), None)

    def _sync_tunnel_buttons(self):
        t = self._selected_tunnel()
        b = self.tunnel_buttons
        running = bool(t and t["name"] in self.tunnel_runs)
        b["toggle"].configure(text="■  Detener" if running else "▶  Iniciar")
        for key in ("toggle", "edit", "delete"):
            b[key].configure(state="normal" if t else "disabled")

    def _toggle_tunnel(self):
        t = self._selected_tunnel()
        if not t:
            return
        if t["name"] in self.tunnel_runs:
            self._stop_tunnel()
        else:
            self._start_tunnel()

    def _tunnel_menu(self, event):
        row = self.tunnel_tree.identify_row(event.y)
        if not row:
            return
        self.tunnel_tree.selection_set(row)
        self.tunnel_tree.focus(row)
        t = self._selected_tunnel()
        menu = tk.Menu(self, tearoff=0)
        menu.add_command(label="Detener" if t["name"] in self.tunnel_runs else "Iniciar", command=self._toggle_tunnel)
        menu.add_command(label=f"Copiar localhost:{t['port']}", command=lambda: self.copy(f"localhost:{t['port']}"))
        menu.add_separator()
        menu.add_command(label="Editar…", command=self._edit_tunnel)
        menu.add_command(label="Borrar…", command=self._delete_tunnel)
        menu.tk_popup(event.x_root, event.y_root)

    def _new_tunnel(self):
        if not self.profiles:
            messagebox.showinfo("Sin perfiles", "Un túnel es de un perfil: creá el perfil primero.", parent=self)
            return
        TunnelEditor(self, None)

    def _edit_tunnel(self):
        t = self._selected_tunnel()
        if t:
            TunnelEditor(self, t)

    def _delete_tunnel(self):
        t = self._selected_tunnel()
        if not t:
            return
        if not messagebox.askyesno("Borrar túnel", f"Se borra el túnel `{t['name']}` (solo la config local). ¿Seguir?",
                                   parent=self):
            return

        def work():
            res = self.cli.remove_tunnel(t["name"])
            if not res.get("ok"):
                self._say(res.get("error"), "err")
                return
            self._say(f"Túnel `{t['name']}` borrado.", "info")
            self._refresh_tunnels()

        self._background(work)

    def _start_tunnel(self):
        t = self._selected_tunnel()
        if not t:
            return
        if t["problems"]:
            messagebox.showwarning("Túnel incompleto",
                                   f"{t['name']} no puede arrancar:\n\n" + "\n".join(t["problems"]), parent=self)
            return
        self.status_var.set(f"Iniciando túnel {t['name']}…")
        self._say(f"> cf-proxy tunnels start {t['name']}", "info")

        def work():
            res = self.cli.start_tunnel(t["name"])
            if res.get("ok"):
                self.launched_tunnels.add(t["name"])
                verb = "ya estaba corriendo" if res.get("already") else "corriendo"
                self._say(f"OK  túnel {t['name']} {verb}: localhost:{res['port']} -> {t['service']} "
                          f"({res.get('remote')} vía {res.get('app')})", "ok")
                self._ui(lambda: self.status_var.set(f"Túnel {t['name']}: localhost:{res['port']}"))
                self._ui(self._poll_now)
                return

            if res.get("tail"):
                for line in res["tail"].splitlines():
                    self._say("  " + line)
            if res.get("code") == NO_SESSION:
                # La sesion es la del perfil del tunel: login de ese perfil y reintentar.
                p = next((x for x in self.profiles if x["name"] == t["profile"]), None)
                if p:
                    self._say(f"{p['name']} no tiene sesión de cf: hace falta login.", "info")
                    self._ui(lambda: self.login(p, then=self._start_tunnel))
                    return
            self._say(f"No arrancó el túnel {t['name']}: {res.get('error')}", "err")
            self._ui(lambda: self.status_var.set(f"Túnel {t['name']}: no arrancó."))

        self._background(work)

    def _stop_tunnel(self):
        t = self._selected_tunnel()
        if not t:
            return
        self._say(f"> cf-proxy tunnels stop {t['name']}", "info")

        def work():
            res = self.cli.stop_tunnel(t["name"])
            if not res.get("ok"):
                self._say(f"No se pudo detener el túnel {t['name']}: {res.get('error')}", "err")
            elif res.get("wasRunning"):
                self._say(f"Túnel {t['name']} detenido.", "info")
            self.launched_tunnels.discard(t["name"])
            self._ui(self._poll_now)

        self._background(work)


class RunTab(ttk.Frame):
    """Una corrida: cabecera con su estado, botones, y el log en vivo."""

    def __init__(self, app, run):
        super().__init__(app.notebook, padding=0)
        self.app = app
        self.name = run["profile"]
        self.run = run
        self.log_path = run.get("log")
        self.offset = 0

        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        head = tk.Frame(self, background=theme.SURFACE, padx=px(14), pady=px(10))
        head.grid(row=0, column=0, sticky="ew")
        head.columnconfigure(0, weight=1)

        # Linea 1: titulo y estado. Linea 2: la URL (clic = abrir) y copiarla.
        line = tk.Frame(head, background=theme.SURFACE)
        line.grid(row=0, column=0, sticky="w")
        self.title_label = tk.Label(line, font=app.fonts["tab_title"], background=theme.SURFACE, foreground=theme.TEXT)
        self.title_label.pack(side="left")
        self.pill = tk.Label(line, font=app.fonts["small_bold"], foreground="#ffffff", padx=px(8), pady=px(1))
        self.pill.pack(side="left", padx=(px(10), 0))

        line = tk.Frame(head, background=theme.SURFACE)
        line.grid(row=1, column=0, sticky="w", pady=(px(2), 0))
        self.url_label = tk.Label(line, font=app.fonts["link"], background=theme.SURFACE, foreground=theme.ACCENT,
                                  cursor="hand2")
        self.url_label.pack(side="left")
        self.url_label.bind("<Button-1>", lambda e: not self.stopped and webbrowser.open(self.run["url"]))
        self.stopped = False
        self.copy_label = tk.Label(line, text="copiar", font=app.fonts["small"], background=theme.SURFACE,
                                   foreground=theme.MUTED, cursor="hand2")
        self.copy_label.pack(side="left", padx=(px(8), 0))
        self.copy_label.bind("<Button-1>", lambda e: app.copy(self.run["url"]))

        self.info_var = tk.StringVar()
        tk.Label(head, textvariable=self.info_var, font=app.fonts["small"], background=theme.SURFACE,
                 foreground=theme.MUTED).grid(row=2, column=0, sticky="w", pady=(px(4), 0))
        # Login de usuario (XSUAA): sin el, las destinations PrincipalPropagation
        # y OAuth2UserTokenExchange fallan. Se avisa aca antes de que pase.
        self.login_var = tk.StringVar()
        self.login_label = tk.Label(head, textvariable=self.login_var, background=theme.SURFACE, justify="left",
                                    anchor="w")
        self.login_label.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(px(4), 0))
        # Ocupa todo el ancho y envuelve segun la ventana: el aviso es largo y no se tiene que cortar.
        head.bind("<Configure>", lambda e: self.login_label.configure(wraplength=max(px(300), e.width - px(30))))

        buttons = tk.Frame(head, background=theme.SURFACE)
        buttons.grid(row=0, column=1, rowspan=3, sticky="ne")
        self.open_btn = ttk.Button(buttons, text="Abrir página", style="Accent.TButton",
                                   command=lambda: webbrowser.open(self.run["url"]))
        self.open_btn.pack(side="left")
        self.login_btn = ttk.Button(buttons, text="Login de usuario", command=self._user_login)
        self.login_btn.pack(side="left", padx=(px(6), 0))
        self.stop_btn = ttk.Button(buttons, text="Detener", command=lambda: app.stop(self.name))
        self.stop_btn.pack(side="left", padx=(px(6), 0))
        ttk.Button(buttons, text="✕  Cerrar", command=lambda: app.close_tab(self.name)).pack(side="left", padx=(px(6), 0))

        body = ttk.Frame(self)
        body.grid(row=1, column=0, sticky="nsew")
        body.columnconfigure(0, weight=1)
        body.rowconfigure(0, weight=1)
        self.text = make_log(body)
        if not self.log_path:
            write_log(self.text, "Esta corrida se lanzó en primer plano: su salida está en esa terminal.", "info")

    def _set_state(self, text, color, dot):
        """Pastilla de estado en la cabecera y punto en la pestana."""
        self.pill.configure(text=text, background=color)
        self.app.notebook.tab(self, image=self.app.dots[dot])

    def update_run(self, run):
        # Un registro nuevo (otro pid) es otra corrida: el log se relee desde cero.
        if run["pid"] != self.run.get("pid") or run.get("log") != self.log_path:
            self.log_path = run.get("log")
            self.offset = 0
            clear_log(self.text)
        self.run = run
        self.stopped = False
        origin = {"ui": "ventana", "cli": "consola"}.get(run.get("origin"), run.get("origin") or "?")
        parts = [run.get("user") or "?", f"{run['org']} / {run['space']}", f"puerto {run['port']}",
                 f"pid {run['pid']}", f"lanzado desde {origin}"]
        if run.get("onPremise") is not None:
            parts.append("on-premise: " + ("sí" if run["onPremise"] else "no"))
        self.info_var.set("  ·  ".join(parts))
        self.title_label.configure(text=run.get("title") or self.name)
        self.url_label.configure(text=run["url"], foreground=theme.ACCENT, cursor="hand2")
        ok = run["status"] == "ok"
        self._set_state(run["status"], theme.OK if ok else theme.WARN,
                        "ok" if ok and not LauncherApp._missing_user_login(run) else "warn")
        self.open_btn.configure(state="normal")
        self.stop_btn.configure(state="normal")
        self._show_login(run.get("login"))

    def _show_login(self, login):
        """Linea y boton del login de usuario segun lo que reporta `ps`."""
        if login is None:
            self.login_var.set("Login de usuario: esperando que el proxy responda…")
            self.login_label.configure(foreground=theme.MUTED)
            self.login_btn.configure(state="disabled")
            return
        if not login["configured"]:
            self.login_var.set(f"Login de usuario: no disponible. {login.get('warning') or ''}")
            self.login_label.configure(foreground=theme.MUTED)
            self.login_btn.configure(state="disabled")
            return
        if login["loggedIn"]:
            self.login_var.set(f"✓  Login de usuario: {login.get('user') or 'OK'} "
                               f"(vence {login.get('expiresAt') or '?'}; se renueva solo)")
            self.login_label.configure(foreground=theme.OK)
            self.login_btn.configure(state="normal")
            return
        text = ("⚠  Login de usuario: FALTA. Sin él fallan las destinations PrincipalPropagation "
                "y OAuth2UserTokenExchange.")
        if login.get("warning"):
            text += "\n" + login["warning"]
        self.login_var.set(text)
        self.login_label.configure(foreground=theme.ERR)
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
        self.stopped = True
        self._set_state("detenido", theme.IDLE, "idle")
        self.url_label.configure(foreground=theme.MUTED, cursor="")
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
        self.targets = []

        box = ttk.Frame(self, padding=(px(18), px(12), px(18), px(16)))
        box.pack(fill="both", expand=True)
        box.columnconfigure(1, weight=1)

        self.vars = {k: tk.StringVar(value=str(p.get(k) or "")) for k in ("name", "title", "api", "user", "org", "space", "port")}
        row = 0

        def section(text, hint=""):
            nonlocal row
            head = ttk.Frame(box)
            head.grid(row=row, column=0, columnspan=3, sticky="ew", pady=(px(14) if row else 0, px(2)))
            ttk.Label(head, text=text, style="Section.TLabel").pack(side="left")
            if hint:
                ttk.Label(head, text=hint, style="Hint.TLabel").pack(side="left", padx=(px(8), 0), pady=(px(3), 0))
            ttk.Separator(box).grid(row=row + 1, column=0, columnspan=3, sticky="ew", pady=(0, px(4)))
            row += 2

        def field(label, key, **kw):
            nonlocal row
            ttk.Label(box, text=label).grid(row=row, column=0, sticky="w", **PAD)
            entry = ttk.Entry(box, textvariable=self.vars[key], width=46, **kw)
            entry.grid(row=row, column=1, columnspan=2, sticky="ew", **PAD)
            row += 1
            return entry

        section("Cuenta", "el usuario y la región de la subcuenta")
        first = field("Nombre", "name", state="disabled" if self.editing else "normal")
        title_entry = field("Título", "title")
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
        self.pass_var = tk.StringVar(value=store.get_password(p["api"], p["user"]) if p["user"] else "")
        self.pass_entry = ttk.Entry(box, textvariable=self.pass_var, show="•")
        self.pass_entry.grid(row=row, column=1, sticky="ew", **PAD)
        self.remember_var = tk.BooleanVar(value=True)
        self.remember_check = ttk.Checkbutton(box, text="Recordar", variable=self.remember_var)
        self.remember_check.grid(row=row, column=2, sticky="w", **PAD)
        row += 1

        self.pass_entry.bind("<Return>", lambda e: self._connect())

        section("Destino", "org y space que ve ese usuario")
        ttk.Button(box, text="Conectar y listar orgs", command=self._connect).grid(row=row, column=1, sticky="w", **PAD)
        self.conn_var = tk.StringVar(value="")
        ttk.Label(box, textvariable=self.conn_var, style="Muted.TLabel").grid(row=row, column=2, sticky="w", **PAD)
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
        ttk.Label(box, text="vacío = el siguiente libre", style="Hint.TLabel").grid(row=row, column=2, sticky="w", **PAD)
        row += 1

        section("Opciones")
        flags = p.get("flags") or {}
        self.flag_vars = {k: tk.BooleanVar(value=bool(flags.get(k))) for k in ("tunnel", "login", "create_keys", "open_browser")}
        fbox = ttk.Frame(box)
        fbox.grid(row=row, column=0, columnspan=3, sticky="w", **PAD)
        # En dos columnas, cada una con su "para que": en una sola fila no se entendia cuando marcarlas.
        for i, (key, text, hint) in enumerate((
                ("open_browser", "Abrir la página al arrancar", ""),
                ("login", "Abrir login de usuario", "PrincipalPropagation / UserTokenExchange"),
                ("tunnel", "Forzar túnel SSH", "on-premise sin cf-dest-app en el space"),
                ("create_keys", "Permitir crear service keys", "si las instancias no tienen ninguna"))):
            cell = ttk.Frame(fbox)
            cell.grid(row=i // 2, column=i % 2, sticky="w", padx=(0, px(24)), pady=px(2))
            ttk.Checkbutton(cell, text=text, variable=self.flag_vars[key]).pack(anchor="w")
            if hint:
                ttk.Label(cell, text=hint, style="Hint.TLabel").pack(anchor="w", padx=(px(22), 0))
        row += 1

        actions = ttk.Frame(box)
        actions.grid(row=row, column=0, columnspan=3, sticky="e", pady=(px(16), 0))
        ttk.Button(actions, text="Cancelar", command=self.destroy).pack(side="left")
        ttk.Button(actions, text="Guardar", style="Accent.TButton", command=self._save).pack(side="left", padx=(px(8), 0))

        self._toggle_auth()
        prepare_dialog(self, app, focus=title_entry if self.editing else first)

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
        # La contrasena no se guarda aca: es del usuario (la comparten cf-target y
        # otros perfiles) y se guarda solo despues de un login aceptado (login()).
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
                       on_fail=lambda reason: self.winfo_exists() and self.conn_var.set(reason[:60]),
                       remember=self.remember_var.get())
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


class TunnelEditor(tk.Toplevel):
    """
    Alta y edicion de un tunel. Solo guarda la config local: el host remoto
    no se pide, se lee de los bindings de la instancia al arrancar.
    """

    def __init__(self, app, tunnel):
        super().__init__(app)
        self.app = app
        self.editing = tunnel is not None
        t = tunnel or {"name": "", "profile": app.profiles[0]["name"], "service": "", "port": "", "app": ""}
        self.title(f"Túnel {t['name']}" if self.editing else "Túnel nuevo")

        box = ttk.Frame(self, padding=(px(18), px(14), px(18), px(16)))
        box.pack(fill="both", expand=True)
        box.columnconfigure(1, weight=1)
        self.vars = {k: tk.StringVar(value=str(t.get(k) or "")) for k in ("name", "profile", "service", "port", "app")}

        rows = (
            ("Nombre", "name", ""),
            ("Perfil", "profile", "la subcuenta (org / space) donde está la instancia"),
            ("Instancia", "service", "nombre de la instancia en el space, p.ej. la de postgresql-db"),
            ("Puerto local", "port", "vacío = el siguiente libre desde 15432"),
            ("App de salto", "app", "vacío = cf-dest-app, o una app con SSH"),
        )
        widgets = {}
        for row, (label, key, hint) in enumerate(rows):
            ttk.Label(box, text=label).grid(row=row, column=0, sticky="w", **PAD)
            if key == "profile":
                widget = ttk.Combobox(box, textvariable=self.vars[key], state="readonly",
                                      values=[p["name"] for p in app.profiles], width=30)
            else:
                widget = ttk.Entry(box, textvariable=self.vars[key], width=32 if key != "port" else 8,
                                   state="disabled" if key == "name" and self.editing else "normal")
            widget.grid(row=row, column=1, sticky="w", **PAD)
            widgets[key] = widget
            ttk.Label(box, text=hint, style="Hint.TLabel").grid(row=row, column=2, sticky="w", **PAD)

        actions = ttk.Frame(box)
        actions.grid(row=len(rows), column=0, columnspan=3, sticky="e", pady=(px(14), 0))
        ttk.Button(actions, text="Cancelar", command=self.destroy).pack(side="left")
        ttk.Button(actions, text="Guardar", style="Accent.TButton", command=self._save).pack(side="left", padx=(px(8), 0))
        self.bind("<Return>", lambda e: self._save())
        prepare_dialog(self, app, focus=widgets["service" if self.editing else "name"])

    def _save(self):
        port = self.vars["port"].get().strip()
        data = {
            "name": self.vars["name"].get().strip(),
            "profile": self.vars["profile"].get().strip(),
            "service": self.vars["service"].get().strip(),
            "port": int(port) if port.isdigit() else "auto",
            "app": self.vars["app"].get().strip(),
        }
        if not data["name"] or not data["service"]:
            messagebox.showwarning("Faltan datos", "Nombre e instancia.", parent=self)
            return
        res = self.app.cli.save_tunnel(data, self.editing)
        if not res.get("ok"):
            messagebox.showerror("No se pudo guardar", res.get("error"), parent=self)
            return
        t = res["tunnel"]
        self.app._say(f"Túnel `{t['name']}` guardado (localhost:{t['port']}).", "ok")
        self.app._refresh_tunnels()
        self.destroy()


# ---------------------------------------------------------------------------
# Utilidades de widgets
# ---------------------------------------------------------------------------
def toolbar(parent, spec):
    """
    Botones a la derecha de la cabecera de una seccion. `spec`: tuplas
    (clave, texto, comando, estilo) o ("|",) para un espacio entre grupos.
    Devuelve {clave: boton}, para habilitarlos segun la seleccion.
    """
    bar = ttk.Frame(parent)
    bar.pack(side="right")
    buttons = {}
    for item in spec:
        if item[0] == "|":
            ttk.Frame(bar, width=px(10)).pack(side="left")
            continue
        key, text, cmd, style = item
        b = ttk.Button(bar, text=text, command=cmd, style=style or "TButton")
        b.pack(side="left", padx=(px(4), 0))
        buttons[key] = b
    return buttons


def make_tree(parent, cols, height, widths):
    """Treeview con scroll, encabezados y filas en cebra. `widths`: col -> (titulo, ancho a 96 dpi)."""
    frame = ttk.Frame(parent)
    frame.grid(row=1, column=0, sticky="ew")
    frame.columnconfigure(0, weight=1)
    tree = ttk.Treeview(frame, columns=cols, height=height, selectmode="browse")
    for col, (title, width) in widths.items():
        tree.heading(col, text=title, anchor="w" if col != "port" else "center")
        tree.column(col, width=px(width), minwidth=px(50), anchor="center" if col == "port" else "w",
                    stretch=col == cols[-1])
    tree.tag_configure("odd", background=theme.ZEBRA)
    tree.tag_configure("problem", foreground=theme.ERR)
    tree.grid(row=0, column=0, sticky="ew")
    bar = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
    bar.grid(row=0, column=1, sticky="ns")
    tree.configure(yscrollcommand=bar.set)
    return tree


def empty_hint(tree, text):
    """Texto centrado sobre una tabla vacia, para que no parezca que algo fallo."""
    return tk.Label(tree, text=text, background=theme.SURFACE, foreground=theme.MUTED)


def show_empty(label, empty):
    if empty:
        label.place(relx=0.5, rely=0.58, anchor="center")
    else:
        label.place_forget()


def prepare_dialog(win, parent, focus=None):
    """Modal, centrado sobre la ventana, Esc cancela."""
    win.transient(parent)
    win.resizable(False, False)
    win.configure(background=theme.BG)
    win.bind("<Escape>", lambda e: win.destroy())
    win.update_idletasks()
    x = parent.winfo_rootx() + (parent.winfo_width() - win.winfo_reqwidth()) // 2
    y = parent.winfo_rooty() + max(0, (parent.winfo_height() - win.winfo_reqheight()) // 3)
    win.geometry(f"+{max(0, x)}+{max(0, y)}")
    if focus is not None:
        focus.focus_set()
    win.grab_set()


def make_log(parent):
    """Text de solo lectura con scroll y colores por tipo de linea."""
    text = tk.Text(parent, wrap="none", height=14, state="disabled",
                   background="#1e1e1e", foreground="#d4d4d4", selectbackground="#264f78",
                   insertbackground="#d4d4d4", font=parent.winfo_toplevel().fonts["mono"],
                   borderwidth=0, highlightthickness=0, padx=px(10), pady=px(8))
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
    box = ttk.Frame(win, padding=(px(18), px(14), px(18), px(14)))
    box.pack(fill="both", expand=True)
    var = tk.StringVar()
    ttk.Label(box, text=prompt, wraplength=px(380), justify="left").pack(anchor="w", pady=(0, px(8)))
    entry = ttk.Entry(box, textvariable=var, width=44, show="•")
    entry.pack(fill="x")
    result = {"value": ""}

    def accept():
        result["value"] = var.get().strip()
        win.destroy()

    actions = ttk.Frame(box)
    actions.pack(anchor="e", pady=(px(14), 0))
    ttk.Button(actions, text="Cancelar", command=win.destroy).pack(side="left")
    ttk.Button(actions, text="Aceptar", style="Accent.TButton", command=accept).pack(side="left", padx=(px(8), 0))
    entry.bind("<Return>", lambda e: accept())
    prepare_dialog(win, parent, focus=entry)
    parent.wait_window(win)
    return result["value"]


def main():
    theme.enable_dpi_awareness()
    LauncherApp().mainloop()
