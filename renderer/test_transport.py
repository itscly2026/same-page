"""Real HTTP authentication and completion framing, using the native PDF parser."""
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time
import unittest
import uuid

SECRET = "same-page-native-renderer-test-secret-only"
ROOT = Path(__file__).parent


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.child = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "0"],
                                     env={**os.environ, "PDF_RENDERER_SECRET": SECRET}, stdout=subprocess.PIPE)
        cls.port = int(cls.child.stdout.readline())
        cls.pdf = (ROOT / "fixtures/score-specimen.pdf").read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.child.terminate()
        cls.child.wait(timeout=5)
        cls.child.stdout.close()

    def request(self, data, secret=SECRET, age=0):
        timestamp = str(int(time.time()) - age)
        nonce = str(uuid.uuid4())
        digest = hashlib.sha256(self.pdf).hexdigest()
        signature = hmac.new(secret.encode(), f"POST\n/convert\n{timestamp}\n{nonce}\n{digest}".encode(), hashlib.sha256).hexdigest()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        conn.request("POST", "/convert", data, {"X-Render-Time": timestamp, "X-Render-Nonce": nonce,
                     "X-Render-Sha256": digest, "X-Render-Signature": signature})
        response = conn.getresponse()
        status, body = response.status, response.read()
        conn.close()
        return status, body

    def test_unauthorized_expired_and_modified_pdf_are_rejected(self):
        self.assertEqual(self.request(self.pdf, secret="wrong")[0], 403)
        self.assertEqual(self.request(self.pdf, age=120)[0], 403)
        self.assertEqual(self.request(b"modified")[0], 422)

    def test_complete_conversion_matches_reviewed_images(self):
        status, body = self.request(self.pdf)
        self.assertEqual(status, 200)
        offset = 0
        def frame():
            nonlocal offset
            size = struct.unpack(">I", body[offset:offset+4])[0]
            offset += 4
            data = body[offset:offset+size]
            offset += size
            return data
        geometry = json.loads(frame())
        self.assertEqual(len(geometry["pages"]), 3)
        for page in range(1, 4):
            for edge in (2048, 3072):
                self.assertEqual(frame(), (ROOT / f"fixtures/specimen-{page}-{edge}.png").read_bytes())
        self.assertEqual(frame(), b"")
        self.assertEqual(offset, len(body))

    @unittest.skipUnless(sys.platform == "linux", "Linux seccomp boundary")
    def test_parser_cannot_open_network_socket(self):
        result = subprocess.run([sys.executable, "-c", "from sandbox import isolate; isolate(); import socket; socket.socket()"],
                                cwd=ROOT, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"Operation not permitted", result.stderr)


if __name__ == "__main__":
    unittest.main()
