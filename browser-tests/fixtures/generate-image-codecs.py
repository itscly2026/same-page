"""Generate an original two-page geometric PDF; requires Pillow with JPEG2000.

No score, scan, or third-party PDF content is included. Page 1 is CCITT Group 4;
page 2 is JPEG2000. Both contain the same black square on a white background.
"""
from io import BytesIO
from pathlib import Path
from PIL import Image, ImageDraw

image = Image.new('1', (64, 64), 1)
ImageDraw.Draw(image).rectangle((16, 16, 47, 47), fill=0)
tiff = BytesIO()
image.save(tiff, format='TIFF', compression='group4')
encoded = Image.open(BytesIO(tiff.getvalue()))
offset, = encoded.tag_v2[273]
length, = encoded.tag_v2[279]
ccitt = tiff.getvalue()[offset:offset + length]
jpx = BytesIO()
image.convert('RGB').save(jpx, format='JPEG2000', irreversible=False)

objects = []
def add(body):
    objects.append(body.encode() if isinstance(body, str) else body)
def stream(dictionary, data):
    return f'<< {dictionary} /Length {len(data)} >>\nstream\n'.encode() + data + b'\nendstream'
add('<< /Type /Catalog /Pages 2 0 R >>')
add('<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>')
for page, data, codec in [(3, ccitt, '/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 64 /Rows 64 /BlackIs1 true >>'), (6, jpx.getvalue(), '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode')]:
    add(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 256 256] /Resources << /XObject << /Im {page+2} 0 R >> >> /Contents {page+1} 0 R >>')
    add(stream('', b'q 256 0 0 256 0 0 cm /Im Do Q'))
    add(stream('/Type /XObject /Subtype /Image /Width 64 /Height 64 ' + codec, data))
pdf = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
offsets = [0]
for number, body in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += f'{number} 0 obj\n'.encode() + body + b'\nendobj\n'
xref = len(pdf)
pdf += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
for offset in offsets[1:]:
    pdf += f'{offset:010} 00000 n \n'.encode()
pdf += f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
Path(__file__).with_name('image-codecs.pdf').write_bytes(pdf)
