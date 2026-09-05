from pathlib import Path
from pypdf import PdfReader, PdfWriter
root = Path(__file__).parent
writer = PdfWriter()
writer.add_page(PdfReader(root / "music-font.pdf").pages[0])
writer.add_page(PdfReader(root / "scan.pdf").pages[0])
page = PdfReader(root / "music-font.pdf").pages[0]
page.cropbox.lower_left = (18, 18)
page.cropbox.upper_right = (441, 576)
page.rotate(90)
writer.add_page(page)
writer.write(root / "score-specimen.pdf")
for name in ("music-font.pdf", "scan.pdf", "source.html.txt"):
    (root / name).unlink(missing_ok=True)
