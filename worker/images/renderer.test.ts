import { describe, expect, it } from "vitest";
import { RendererFrames } from "./renderer";

function stream(bytes: number[], chunkSize = 1) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(Uint8Array.from(bytes.slice(i, i + chunkSize)));
    controller.close();
  } });
}
describe("renderer response framing", () => {
  it("reads split length headers and payloads before requiring a terminal frame and EOF", async () => {
    const frames = new RendererFrames(stream([0, 0, 0, 3, 1, 2, 3, 0, 0, 0, 0]));
    expect([...new Uint8Array(await frames.frame(3))]).toEqual([1, 2, 3]);
    await frames.finish();
  });
  it("rejects an oversized frame before reading its payload", async () => {
    await expect(new RendererFrames(stream([2, 0, 0, 1])).frame(32 * 1024 ** 2)).rejects.toThrow("image-size");
  });
  it("rejects truncated images and missing terminal frames", async () => {
    await expect(new RendererFrames(stream([0, 0, 0, 3, 1])).frame(3)).rejects.toThrow("render-truncated");
    await expect(new RendererFrames(stream([])).finish()).rejects.toThrow("render-truncated");
  });
  it("rejects trailing bytes in the current or following stream chunk", async () => {
    for (const chunkSize of [1, 5]) await expect(new RendererFrames(stream([0, 0, 0, 0, 9], chunkSize)).finish()).rejects.toThrow("render-trailing");
  });
});
