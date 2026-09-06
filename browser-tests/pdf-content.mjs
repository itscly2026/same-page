import { expect } from "@playwright/test";

// The sample score contains dark notation on a light page. Read the PDF bitmap
// itself, excluding annotation overlays and surrounding reader chrome. Both
// transparent/white canvases and solid error fills must fail this proof.
export async function expectSampleScoreContent(page) {
  const canvas = page.locator('[data-page-turn-current] canvas[data-pdf-canvas-active]').first();
  await expect(canvas).toBeVisible();
  await expect.poll(async () => canvas.evaluate(element => {
    if (element.width < 100 || element.height < 100) return false;
    const { data } = element.getContext("2d").getImageData(0, 0, element.width, element.height);
    let dark = 0, light = 0, samples = 0;
    for (let offset = 0; offset < data.length; offset += 16) {
      samples++;
      if (data[offset + 3] < 250) continue;
      const rgb = [data[offset], data[offset + 1], data[offset + 2]];
      if (rgb.every(value => value < 150)) dark++;
      if (rgb.every(value => value > 225)) light++;
    }
    return dark / samples > 0.001 && light / samples > 0.5;
  }), { message: "Known nonblank sample PDF must paint notation and a light page" }).toBe(true);
}
