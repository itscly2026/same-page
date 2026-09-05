"""Golden image checks and timed conversion measurements. Differences require visual review."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import time
from PIL import Image, ImageChops

root = Path(__file__).parent
output = root.parent / "artifacts/verification/137"
output.mkdir(parents=True, exist_ok=True)
pdf = (root / "fixtures/score-specimen.pdf").read_bytes()
geometry = json.loads(subprocess.check_output([sys.executable, str(root / "render.py")], input=pdf))
measurements = []
for page in range(1, 4):
    for edge in (2048, 3072):
        start = time.monotonic()
        data = subprocess.check_output([sys.executable, str(root / "render.py"), str(page), str(edge)], input=pdf)
        image = Image.open(io.BytesIO(data)).convert("RGB")
        if min(image.size) <= 0 or max(image.size) > edge:
            raise ValueError("pixel-limit")
        if all(low == high for low, high in image.getextrema()):
            raise ValueError("blank-output")
        name = f"specimen-{page}-{edge}.png"
        (output / name).write_bytes(data)
        reference = root / "fixtures" / name
        if reference.exists():
            baseline = Image.open(reference).convert("RGB")
            if image.size != baseline.size or ImageChops.difference(image, baseline).getbbox():
                if "--record" in sys.argv:
                    reference.write_bytes(data)
                else:
                    raise ValueError(f"Image regression requires visual review: {name}")
        elif "--record" in sys.argv:
            reference.write_bytes(data)
        else:
            raise ValueError(f"Missing reviewed reference: {name}")
        measurements.append(dict(page=page,edge=edge,seconds=round(time.monotonic()-start,3),bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),width=image.width,height=image.height))
(output / "renderer-measurements.json").write_text(json.dumps(dict(sourceBytes=len(pdf), geometry=geometry, results=measurements),indent=2))
print(json.dumps(dict(sourceBytes=len(pdf),engine=geometry["engine"], results=measurements)))
