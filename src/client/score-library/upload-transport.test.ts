import { afterEach, expect, it, vi } from "vitest";
import { uploadPdf } from "./upload-transport";

class TestXhr {
  static current: TestXhr;
  upload = { onprogress: (_event: { loaded: number; total: number; lengthComputable: boolean }) => { void _event; }, onload: () => {} };
  onload = () => {};
  onerror = () => {};
  onabort = () => {};
  status = 201;
  responseText = '{"saved":true}';
  open = vi.fn();
  send = vi.fn();
  abort = vi.fn(() => this.onabort());
  getAllResponseHeaders() { return 'Content-Type: application/json\r\nX-Same-Page-Request-Id: test'; }
  constructor() { TestXhr.current = this; }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("reports real byte progress and waits for server confirmation after transfer finishes", async () => {
  vi.stubGlobal("XMLHttpRequest", TestXhr);
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const progress = vi.fn();
  const controller = new AbortController();
  const promise = uploadPdf('/api/choirs/drive/scores', new FormData(), controller.signal, progress);
  const settled = vi.fn();
  void promise.then(settled);
  now.mockReturnValue(2000);
  TestXhr.current.upload.onprogress({ loaded: 500, total: 1000, lengthComputable: true });
  expect(progress).toHaveBeenLastCalledWith({ percent: 50, bytesPerSecond: 250, processing: false });
  TestXhr.current.upload.onload();
  await Promise.resolve();
  expect(progress).toHaveBeenLastCalledWith({ percent: 100, bytesPerSecond: 0, processing: true });
  expect(settled).not.toHaveBeenCalled();
  TestXhr.current.onload();
  const response = await promise;
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ saved: true });
  controller.abort();
  expect(TestXhr.current.abort).not.toHaveBeenCalled();
});

it("preserves a 503 response without retrying the POST", async () => {
  vi.stubGlobal("XMLHttpRequest", TestXhr);
  const promise = uploadPdf('/api/choirs/drive/scores', new FormData(), new AbortController().signal, vi.fn());
  TestXhr.current.status = 503;
  TestXhr.current.onload();
  expect((await promise).status).toBe(503);
  expect(TestXhr.current.send).toHaveBeenCalledTimes(1);
});

it("aborts the active request when its queue deadline expires", async () => {
  vi.stubGlobal("XMLHttpRequest", TestXhr);
  const controller = new AbortController();
  const promise = uploadPdf('/api/choirs/drive/scores', new FormData(), controller.signal, vi.fn());
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  expect(TestXhr.current.abort).toHaveBeenCalledTimes(1);
});

it("uses indeterminate progress when the browser cannot compute the total", async () => {
  vi.stubGlobal("XMLHttpRequest", TestXhr);
  const progress = vi.fn();
  const promise = uploadPdf('/api/choirs/drive/scores', new FormData(), new AbortController().signal, progress);
  TestXhr.current.upload.onprogress({ loaded: 100, total: 0, lengthComputable: false });
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ percent: null, processing: false }));
  TestXhr.current.onerror();
  await expect(promise).rejects.toBeInstanceOf(TypeError);
});

it("does not send an already aborted upload", async () => {
  vi.stubGlobal("XMLHttpRequest", TestXhr);
  const controller = new AbortController();
  controller.abort();
  await expect(uploadPdf('/api/choirs/drive/scores', new FormData(), controller.signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
  expect(TestXhr.current.send).not.toHaveBeenCalled();
});
