"""
Dibuja launcher/cf-proxy.ico: el icono del .exe (y del acceso directo, que lo toma del .exe).

    python launcher/make_icon.py

Solo hace falta correrlo si se cambia el dibujo: el .ico queda versionado, asi
que buildear no necesita Pillow. Requiere Pillow (`pip install pillow`).

El dibujo: una nube (BTP) unida por un enlace a un nodo local (tu PC), sobre un
cuadrado redondeado azul. Se dibuja a 1024 px y se reduce a cada tamano del .ico
para que los bordes salgan suaves.
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent / "cf-proxy.ico"
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
S = 1024
TOP, BOTTOM = (0x1a, 0x86, 0xf0), (0x00, 0x4c, 0xb8)
WHITE = (255, 255, 255, 255)


def tile():
    """Cuadrado redondeado con degrade vertical."""
    grad = Image.new("RGBA", (S, S))
    px = grad.load()
    for y in range(S):
        t = y / (S - 1)
        c = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,)
        for x in range(S):
            px[x, y] = c
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((40, 40, S - 40, S - 40), radius=220, fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def glyph(img):
    d = ImageDraw.Draw(img)
    # Nube: tres circulos y una base redondeada.
    d.ellipse((250, 300, 530, 580), fill=WHITE)
    d.ellipse((420, 210, 760, 550), fill=WHITE)
    d.ellipse((620, 360, 830, 570), fill=WHITE)
    d.rounded_rectangle((250, 430, 830, 580), radius=75, fill=WHITE)
    # Enlace hacia abajo y el nodo local (anillo), del mismo blanco.
    d.rounded_rectangle((487, 560, 537, 720), radius=25, fill=WHITE)
    d.ellipse((412, 690, 612, 890), fill=WHITE)
    blue = tuple(round(a + (b - a) * 0.78) for a, b in zip(TOP, BOTTOM)) + (255,)
    d.ellipse((462, 740, 562, 840), fill=blue)
    return img


def main():
    big = glyph(tile())
    images = [big.resize((n, n), Image.LANCZOS) for n in SIZES]
    images[-1].save(OUT, format="ICO", sizes=[(n, n) for n in SIZES], append_images=images[:-1])
    print(f"{OUT}  ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
