"""One untrusted PDF per disposable process. Only fixed metadata/PNG reaches the caller."""
from contextlib import closing
import io
import json
import resource
import sys

# Linux container boundary; macOS only supports the CPU bound reliably.
resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
if sys.platform == "linux":
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024**2, 768 * 1024**2))
from sandbox import isolate
isolate()
import pypdfium2 as pdfium


def convert(data, page_number=None, edge=None):
    with pdfium.PdfDocument(data) as document:
        if not 0 < len(document) <= 200:
            raise ValueError("page-limit")
        if page_number is None:
            pages = []
            for i in range(len(document)):
                with closing(document[i]) as page:
                    width, height = page.get_size()
                    if not 0 < min(width, height) <= max(width, height) <= 100_000:
                        raise ValueError("geometry-limit")
                    pages.append(dict(pageNumber=i + 1, width=width, height=height,
                                      rotation=page.get_rotation(), crop=list(page.get_cropbox())))
            return json.dumps(dict(engine="pdfium-" + str(pdfium.PDFIUM_INFO.version), pages=pages)).encode()
        if not 1 <= page_number <= len(document) or edge not in (2048, 3072):
            raise ValueError("page-limit")
        with closing(document[page_number - 1]) as page:
            width, height = page.get_size()
            if not 0 < min(width, height) <= max(width, height) <= 100_000:
                raise ValueError("geometry-limit")
            # Preserve colour and anti-aliasing. Never threshold music symbols.
            with closing(page.render(scale=(edge - 0.01) / max(width, height))) as bitmap:
                with bitmap.to_pil() as image:
                    output = io.BytesIO()
                    image.convert("RGB").save(output, format="PNG")
                    return output.getvalue()


if __name__ == "__main__":
    try:
        data = sys.stdin.buffer.read(50 * 1024**2 + 1)
        if len(data) > 50 * 1024**2:
            raise ValueError("source-limit")
        sys.stdout.buffer.write(convert(data, *[int(x) for x in sys.argv[1:]]))
    except Exception:
        # No raw document errors, file content, paths or credentials in logs.
        sys.exit(1)
