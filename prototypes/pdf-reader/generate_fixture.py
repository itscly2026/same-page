"""Generate the throwaway multi-page PDF used by the reader prototype."""

from math import sin
from pathlib import Path

from reportlab.lib.colors import Color, HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


OUTPUT = Path(__file__).parents[2] / "output" / "pdf" / "reader-test-score.pdf"
PAGE_COUNT = 24


def draw_staff(pdf: canvas.Canvas, y: float, page_number: int, system: int) -> None:
    left = 50
    right = A4[0] - 50
    gap = 8
    pdf.setStrokeColor(HexColor("#5e5b55"))
    pdf.setLineWidth(0.55)
    for line in range(5):
        pdf.line(left, y - line * gap, right, y - line * gap)

    pdf.setFillColor(HexColor("#262421"))
    for beat in range(16):
        x = left + 24 + beat * ((right - left - 48) / 15)
        wave = sin((beat + page_number + system) * 0.83)
        note_y = y - 16 + wave * 11
        pdf.circle(x, note_y, 3.1, fill=1, stroke=0)
        stem_up = (beat + page_number) % 3 != 0
        if stem_up:
            pdf.line(x + 3, note_y, x + 3, note_y + 25)
        else:
            pdf.line(x - 3, note_y, x - 3, note_y - 25)
        if beat in (3, 7, 11, 15):
            bar_x = x + 10
            pdf.setLineWidth(0.9)
            pdf.line(bar_x, y + 3, bar_x, y - gap * 4 - 3)


def build() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(OUTPUT), pagesize=A4, pageCompression=1)
    width, height = A4
    for page_number in range(1, PAGE_COUNT + 1):
        pdf.setFillColor(HexColor("#fffdf8"))
        pdf.rect(0, 0, width, height, fill=1, stroke=0)

        pdf.setFillColor(HexColor("#201f1c"))
        pdf.setFont("Helvetica-Bold", 14)
        pdf.drawString(50, height - 48, "Same Page - Reader Performance Fixture")
        pdf.setFont("Helvetica", 9)
        pdf.setFillColor(HexColor("#706b63"))
        pdf.drawRightString(width - 50, height - 46, f"Page {page_number} / {PAGE_COUNT}")

        for system in range(7):
            top = height - 105 - system * 95
            draw_staff(pdf, top, page_number, system)
            pdf.setFont("Helvetica", 7)
            pdf.setFillColor(Color(0.38, 0.36, 0.33, 1))
            pdf.drawString(51, top + 11, f"System {system + 1}  rehearsal {page_number}.{system + 1}")

        pdf.setStrokeColor(HexColor("#d8d2c8"))
        pdf.setLineWidth(0.5)
        pdf.line(50, 42, width - 50, 42)
        pdf.setFont("Helvetica", 7)
        pdf.setFillColor(HexColor("#8a847b"))
        pdf.drawCentredString(width / 2, 28, "Synthetic vector score - prototype fixture only")
        pdf.showPage()

    pdf.save()
    print(f"wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes, {PAGE_COUNT} pages)")


if __name__ == "__main__":
    build()
