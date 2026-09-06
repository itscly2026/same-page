"""Authenticated whole-PDF transport; streams bounded PNG frames, never logs PDFs."""
import ctypes
import hashlib
import hmac
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
import re
import socketserver
import struct
import subprocess
import sys
import time

if sys.platform == "linux" and ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) != 0:
    sys.exit("renderer isolation failed")
SECRET = os.environ.pop("PDF_RENDERER_SECRET", "")
BUILD = os.environ.get("RENDERER_BUILD_ID", "local")
CONTENT_TYPE = "application/vnd.samepage.images-v1"
MAX_PDF = 20 * 1024**2


class RendererServer(HTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "renderer"
        self.server_port = self.server_address[1]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def reply(self, status, data=b""):
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404)
        self.reply(200, json.dumps(dict(buildId=BUILD)).encode())

    def authorized(self):
        timestamp = self.headers.get("X-Render-Time", "")
        nonce = self.headers.get("X-Render-Nonce", "")
        digest = self.headers.get("X-Render-Sha256", "")
        signature = self.headers.get("X-Render-Signature", "")
        if (len(SECRET) < 32 or not re.fullmatch(r"[0-9]{10}", timestamp)
                or abs(time.time() - int(timestamp)) > 60
                or not re.fullmatch(r"[0-9a-f-]{36}", nonce)
                or not re.fullmatch(r"[0-9a-f]{64}", digest)
                or not re.fullmatch(r"[0-9a-f]{64}", signature)):
            return False
        message = f"POST\n/convert\n{timestamp}\n{nonce}\n{digest}".encode()
        return hmac.compare_digest(hmac.new(SECRET.encode(), message, hashlib.sha256).hexdigest(), signature)

    def chunk(self, data):
        self.wfile.write(f"{len(data):x}\r\n".encode())
        self.wfile.write(data)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def frame(self, data):
        self.chunk(struct.pack(">I", len(data)))
        if data:
            self.chunk(data)

    def do_POST(self):
        started = False
        try:
            self.connection.settimeout(20)
            if self.path != "/convert":
                return self.reply(404)
            if not self.authorized():
                return self.reply(403)
            length = int(self.headers.get("Content-Length", "0"))
            if self.headers.get("Transfer-Encoding") or not 0 < length <= MAX_PDF:
                return self.reply(413)
            pdf = self.rfile.read(length)
            if len(pdf) != length or hashlib.sha256(pdf).hexdigest() != self.headers["X-Render-Sha256"]:
                return self.reply(422)
            deadline = time.monotonic() + 170

            def render(*arguments):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("deadline")
                result = subprocess.run([sys.executable, str(Path(__file__).with_name("render.py")), *map(str, arguments)],
                                        input=pdf, capture_output=True, timeout=min(20, remaining), check=True,
                                        env={"PATH": os.defpath})
                if len(result.stdout) > 32 * 1024**2:
                    raise ValueError("image-size")
                return result.stdout

            geometry = render()
            pages = json.loads(geometry)["pages"]
            self.send_response(200)
            self.send_header("Content-Type", CONTENT_TYPE)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            started = True
            self.frame(geometry)
            total = 0
            for page in pages:
                for edge in (2048, 3072):
                    data = render(page["pageNumber"], edge)
                    total += len(data)
                    if total > 512 * 1024**2:
                        raise ValueError("output-limit")
                    self.frame(data)
            self.frame(b"")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except Exception:
            # A partial response has no terminal frame. The Worker fails the job;
            # it must never publish a partial manifest or receive raw PDF errors.
            if not started:
                self.reply(422)
        finally:
            self.close_connection = True


if __name__ == "__main__":
    if len(SECRET) < 32:
        sys.exit("renderer secret is required")
    server = RendererServer(("127.0.0.1" if len(sys.argv) > 1 else "0.0.0.0",
                             int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8080"))), Handler)
    print(server.server_port, flush=True)
    server.serve_forever()
