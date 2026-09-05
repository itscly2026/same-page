"""Private container HTTP transport; no public URL, credentials or outbound access."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
import socketserver
import subprocess
import sys
from urllib.parse import urlparse, parse_qs


class RendererServer(HTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "renderer"
        self.server_port = self.server_address[1]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        try:
            self.connection.settimeout(20)
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 50 * 1024**2:
                raise ValueError()
            url = urlparse(self.path)
            arguments = []
            if url.path == "/render":
                query = parse_qs(url.query)
                arguments = [str(int(query["page"][0])), str(int(query["edge"][0]))]
            elif url.path != "/inspect":
                raise ValueError()
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("render.py")), *arguments],
                                    input=self.rfile.read(length), capture_output=True, timeout=20, check=True)
            if len(result.stdout) > 32 * 1024**2:
                raise ValueError()
            self.send_response(200)
            self.send_header("Content-Type", "image/png" if arguments else "application/json")
            self.send_header("Content-Length", str(len(result.stdout)))
            self.end_headers()
            self.wfile.write(result.stdout)
        except Exception:
            self.send_response(422)
            self.end_headers()


if __name__ == "__main__":
    server = RendererServer(("127.0.0.1" if len(sys.argv) > 1 else "0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 8080), Handler)
    print(server.server_port, flush=True)
    server.serve_forever()
