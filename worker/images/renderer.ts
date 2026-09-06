import type { Env } from "../env";

const encoder = new TextEncoder();
export async function openRenderer(env: Env, pdf: ArrayBuffer, hash: string, signal: AbortSignal) {
  const url = new URL(env.PDF_RENDERER_URL);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) throw new Error("renderer-config");
  if (!env.PDF_RENDERER_SECRET || env.PDF_RENDERER_SECRET.length < 32) throw new Error("renderer-config");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.PDF_RENDERER_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`POST\n/convert\n${timestamp}\n${nonce}\n${hash}`));
  const response = await fetch(new URL("/convert", url), {
    method: "POST", body: pdf, redirect: "manual", signal,
    headers: { "Content-Type": "application/pdf", "X-Render-Time": timestamp, "X-Render-Nonce": nonce,
      "X-Render-Sha256": hash, "X-Render-Signature": [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("") },
  });
  if (!response.ok || !response.body || response.headers.get("content-type") !== "application/vnd.samepage.images-v1") {
    await response.body?.cancel(); throw new Error("render-failed");
  }
  return new RendererFrames(response.body);
}

// Length-prefixed frames keep the Worker bounded to one image. A zero-length
// terminal frame plus EOF distinguishes complete conversion from a broken stream.
export class RendererFrames {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array(0);
  private offset = 0;
  constructor(body: ReadableStream<Uint8Array>) { this.reader = body.getReader(); }
  private async read(size: number): Promise<Uint8Array<ArrayBuffer>> {
    const output = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      if (this.offset === this.chunk.length) {
        const next = await this.reader.read();
        if (next.done) throw new Error("render-truncated");
        this.chunk = next.value; this.offset = 0;
      }
      const count = Math.min(size - written, this.chunk.length - this.offset);
      output.set(this.chunk.subarray(this.offset, this.offset + count), written);
      this.offset += count; written += count;
    }
    return output;
  }
  async frame(maxBytes: number): Promise<ArrayBuffer> {
    const size = new DataView((await this.read(4)).buffer).getUint32(0);
    if (!size || size > maxBytes) throw new Error("image-size");
    return (await this.read(size)).buffer;
  }
  async finish() {
    if (new DataView((await this.read(4)).buffer).getUint32(0) !== 0 || this.offset !== this.chunk.length) throw new Error("render-trailing");
    if (!(await this.reader.read()).done) throw new Error("render-trailing");
  }
  async close() { await this.reader.cancel().catch(() => undefined); }
}
