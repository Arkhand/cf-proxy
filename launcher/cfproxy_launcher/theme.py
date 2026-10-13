"""
Aspecto de la ventana, con ttk pelado (sin paquetes extra: el .exe sigue chico).

Por que `clam` y no el theme nativo `vista`: `vista` dibuja botones y
encabezados con el sistema e ignora casi todos los colores, asi que no se puede
tener un boton principal ni encabezados planos. `clam` lo dibuja Tk y respeta
todo lo que se configura aca.

Tambien:
  - DPI awareness. Sin esto, en pantallas al 125%/150% Windows estira la
    ventana como bitmap y el texto sale borroso. Con esto las fuentes escalan
    solas (estan en puntos) y `px()` escala lo que esta en pixeles.
  - Puntos de color para los estados, dibujados en memoria (sin archivos de
    imagen que empaquetar).
"""
import ctypes
import sys
import tkinter as tk
import tkinter.font as tkfont
from tkinter import ttk

# Paleta cercana a SAP Horizon, para que no desentone al lado de las tools de BTP.
BG = "#f4f6f9"
SURFACE = "#ffffff"
ZEBRA = "#f8f9fb"
BORDER = "#d5dbe3"
TEXT = "#1d2d3e"
MUTED = "#5b6b7d"
ACCENT = "#0064d9"
ACCENT_HOVER = "#0053b3"
ACCENT_SOFT = "#dcebfb"
OK = "#188918"
WARN = "#c35500"
ERR = "#c0262d"
IDLE = "#8a9bae"

_scale = 1.0


def enable_dpi_awareness():
    """Antes de crear Tk. No hace nada en otros sistemas ni en Windows viejos."""
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except (AttributeError, OSError):
        pass


def px(n):
    """Pixeles a 96 dpi -> pixeles en esta pantalla."""
    return int(round(n * _scale))


def apply(root):
    """Fuentes y estilos de toda la app. Una vez, justo despues de Tk()."""
    global _scale
    _scale = root.winfo_fpixels("1i") / 96.0

    families = set(tkfont.families(root))
    ui = "Segoe UI" if "Segoe UI" in families else "TkDefaultFont"
    mono = next((f for f in ("Cascadia Mono", "Consolas") if f in families), "TkFixedFont")

    for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont"):
        tkfont.nametofont(name).configure(family=ui, size=10)
    tkfont.nametofont("TkHeadingFont").configure(family=ui, size=9, weight="bold")
    fonts = {
        "title": tkfont.Font(root, family=ui, size=15, weight="bold"),
        "section": tkfont.Font(root, family=ui, size=11, weight="bold"),
        "tab_title": tkfont.Font(root, family=ui, size=12, weight="bold"),
        "small": tkfont.Font(root, family=ui, size=9),
        "small_bold": tkfont.Font(root, family=ui, size=9, weight="bold"),
        "link": tkfont.Font(root, family=ui, size=10, underline=True),
        "mono": tkfont.Font(root, family=mono, size=9),
    }
    root.fonts = fonts
    root.configure(background=BG)
    # Los menus (clic derecho) siguen los mismos colores donde Windows lo deja.
    root.option_add("*Menu.background", SURFACE)
    root.option_add("*Menu.activeBackground", ACCENT_SOFT)
    root.option_add("*Menu.activeForeground", TEXT)
    root.option_add("*Menu.relief", "flat")
    root.option_add("*TCombobox*Listbox.selectBackground", ACCENT_SOFT)
    root.option_add("*TCombobox*Listbox.selectForeground", TEXT)

    s = ttk.Style(root)
    s.theme_use("clam")
    flat = {"bordercolor": BORDER, "lightcolor": SURFACE, "darkcolor": SURFACE}

    s.configure(".", background=BG, foreground=TEXT, font="TkDefaultFont",
                focuscolor=ACCENT, troughcolor=BG, **{k: v for k, v in flat.items() if k != "bordercolor"})
    s.configure("TFrame", background=BG)
    s.configure("TLabel", background=BG, foreground=TEXT)
    s.configure("Title.TLabel", font=fonts["title"])
    s.configure("Section.TLabel", font=fonts["section"])
    s.configure("Muted.TLabel", foreground=MUTED)
    s.configure("Hint.TLabel", foreground=MUTED, font=fonts["small"])
    s.configure("TSeparator", background=BORDER)

    # Botones planos y blancos; la accion principal de cada bloque, en azul.
    # relief "raised" y no "flat": con "flat" clam no dibuja el borde. Light/dark
    # iguales al fondo dejan solo el contorno fino. width -6: clam trae -11 (botones muy anchos).
    s.configure("TButton", background=SURFACE, foreground=TEXT, padding=(px(10), px(4)),
                relief="raised", borderwidth=1, width=-6, **flat)
    s.map("TButton",
          background=[("disabled", BG), ("pressed", "#e4e9f0"), ("active", "#eef2f7")],
          foreground=[("disabled", "#a7b3c1")],
          bordercolor=[("focus", ACCENT)])
    s.configure("Accent.TButton", background=ACCENT, foreground="#ffffff",
                bordercolor=ACCENT, lightcolor=ACCENT, darkcolor=ACCENT)
    s.map("Accent.TButton",
          background=[("disabled", "#a9c8ee"), ("pressed", ACCENT_HOVER), ("active", ACCENT_HOVER)],
          foreground=[("disabled", "#ffffff")],
          bordercolor=[("disabled", "#a9c8ee"), ("focus", "#003f8a")],
          lightcolor=[("disabled", "#a9c8ee"), ("active", ACCENT_HOVER)],
          darkcolor=[("disabled", "#a9c8ee"), ("active", ACCENT_HOVER)])

    s.configure("Treeview", background=SURFACE, fieldbackground=SURFACE, foreground=TEXT,
                rowheight=px(28), borderwidth=1, **flat)
    s.map("Treeview", background=[("selected", ACCENT_SOFT)], foreground=[("selected", TEXT)])
    s.configure("Treeview.Heading", background=BG, foreground=MUTED, relief="flat",
                padding=(px(6), px(4)), borderwidth=0, lightcolor=BG, darkcolor=BG, bordercolor=BORDER)
    s.map("Treeview.Heading", background=[("active", "#e9edf2")])

    s.configure("TNotebook", background=BG, borderwidth=0, tabmargins=(0, px(4), 0, 0))
    s.configure("TNotebook.Tab", background=BG, foreground=MUTED, padding=(px(14), px(6)),
                borderwidth=0, lightcolor=BG, bordercolor=BORDER)
    s.map("TNotebook.Tab",
          background=[("selected", SURFACE), ("active", "#e9edf2")],
          foreground=[("selected", TEXT)],
          lightcolor=[("selected", SURFACE)])

    for w in ("TEntry", "TCombobox"):
        s.configure(w, fieldbackground=SURFACE, padding=px(4), **flat)
        s.map(w, bordercolor=[("focus", ACCENT)], lightcolor=[("focus", ACCENT)],
              fieldbackground=[("disabled", BG), ("readonly", SURFACE)],
              foreground=[("disabled", "#8795a5")])
    for w in ("TCheckbutton", "TRadiobutton"):
        s.configure(w, background=BG, indicatorbackground=SURFACE, indicatorforeground=ACCENT,
                    upperbordercolor=BORDER, lowerbordercolor=BORDER)
    s.map("TCheckbutton", background=[("active", BG)])
    s.map("TRadiobutton", background=[("active", BG)])

    s.configure("TScrollbar", background=BG, troughcolor=BG, arrowcolor=MUTED, borderwidth=0,
                lightcolor=BG, darkcolor=BG, bordercolor=BG, gripcount=0)
    s.map("TScrollbar", background=[("active", "#dfe5ec")])
    s.configure("Busy.Horizontal.TProgressbar", background=ACCENT, troughcolor="#e4e9f0",
                bordercolor=BG, lightcolor=ACCENT, darkcolor=ACCENT, thickness=px(4))
    s.configure("Sash", sashthickness=px(8), background=BG, gripcount=0)
    return fonts


def dot(root, color, size=10, background=SURFACE):
    """
    Un circulo lleno como PhotoImage. Tk 8.6 no tiene alfa, asi que el borde se
    mezcla a mano contra `background`: sobre las filas blancas se ve suave.
    """
    size = px(size)
    img = tk.PhotoImage(master=root, width=size, height=size)
    r = size / 2.0
    for y in range(size):
        row = []
        for x in range(size):
            d = ((x + 0.5 - r) ** 2 + (y + 0.5 - r) ** 2) ** 0.5
            cover = max(0.0, min(1.0, r - d + 0.5))
            if cover == 0:
                row.append(None)
                continue
            row.append(_mix(background, color, cover))
        for x, c in enumerate(row):
            if c:
                img.put(c, (x, y))
    return img


def _mix(a, b, t):
    """Color entre a (t=0) y b (t=1)."""
    pa = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    pb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(round(x + (y - x) * t) for x, y in zip(pa, pb))
