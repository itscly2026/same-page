import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { webkit } from "playwright";

const styles = await readFile(
  new URL("../src/client/styles.css", import.meta.url),
  "utf8",
);
const sampleText = "第一排男高音这里请统一";
const longChineseText = "第一排男高音这里请统一提前吸气并保持轻声进入";

test("text wrapping and readable bounds remain proportional across zoom", async context => {
  const browser = await testBrowser(context);
  const page = await browser.newPage({ viewport: { width: 1800, height: 1800 } });
  for (const [name, text, font, lines] of [
    ["short", sampleText, 2.4, 1],
    ["small-padding", "排".repeat(41), 1.2, 1],
    ["chinese", longChineseText, 2.4, 2],
    ["explicit-break", "第一排统一\n第二排保持轻声", 2.4, 2],
    ["unbroken-url", "https://samepage.example/rehearsal/tenor-breathe-together-before-entry", 2.4, null],
  ]) {
    await setFixture(page, [556.4, 695.5, 1112.8, 1669.2]
      .map((width, i) => annotationPage(name + i, width, text, font)).join(""));
    const layouts = await measureTextLayouts(page);
    if (lines === null) assert.ok(layouts[0].lineCount > 1, name);
    assert.deepEqual(layouts.map(layout => layout.lineCount), layouts.map(() => lines ?? layouts[0].lineCount), name);
    if (name === "chinese") assertNormalizedLayouts(layouts, lines);
    assert.ok(layouts.every(layout => layout.contentFits), name + ": content is clipped");
  }
});

test("gives short editable text a 44px hit target without enlarging its visual bounds", async (context) => {
  const browser = await testBrowser(context);
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });

  await setFixture(page, annotationPage("short-note", 556.4, "换", 2.4, true));

  const result = await page.locator("#short-note").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hitBox = getComputedStyle(element, "::before");
    const center = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const hitOffsets = [-21.5, 21.5];
    return {
      visualWidth: box.width,
      visualHeight: box.height,
      hitWidth: Number.parseFloat(hitBox.width),
      hitHeight: Number.parseFloat(hitBox.height),
      corners: hitOffsets.flatMap((x) =>
        hitOffsets.map((y) => document.elementFromPoint(center.x + x, center.y + y)?.id),
      ),
    };
  });

  assert.ok(result.visualWidth < 44);
  assert.ok(result.visualHeight < 44);
  assert.ok(result.hitWidth >= 44);
  assert.ok(result.hitHeight >= 44);
  assert.deepEqual(result.corners, [
    "short-note",
    "short-note",
    "short-note",
    "short-note",
  ]);
});

test("keeps pinch preview geometry equal to the committed zoom layout", async (context) => {
  const browser = await testBrowser(context);
  const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });

  await setFixture(page, `
    <div style="transform: scale(2); transform-origin: 0 0">
      ${annotationPage("pinch-preview", 556.4, sampleText)}
    </div>
    <div style="margin-top: 260px">
      ${annotationPage("committed-zoom", 1112.8, sampleText)}
    </div>
  `);

  const layouts = await measureTextLayouts(page);
  assert.deepEqual(layouts.map(({ id, lineCount }) => ({ id, lineCount })), [
    { id: "pinch-preview", lineCount: 1 },
    { id: "committed-zoom", lineCount: 1 },
  ]);
  assert.ok(
    Math.abs(layouts[0].width - layouts[1].width) / layouts[1].width < 0.01,
    JSON.stringify(layouts),
  );
  assert.ok(
    Math.abs(layouts[0].height - layouts[1].height) < 0.5,
    JSON.stringify(layouts),
  );
});

async function testBrowser(context) {
  const browser = await webkit.launch({ headless: true });
  context.after(() => browser.close());
  return browser;
}

async function setFixture(page, fixture) {
  await page.setContent(`<style>${styles}</style>${fixture}`);
}

async function measureTextLayouts(page) {
  return page.locator(".annotation-text").evaluateAll((elements) =>
    elements.map((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const pageBounds = (
        element.closest(".annotated-pdf-page") ?? element.parentElement
      ).getBoundingClientRect();
      const textBounds = element.getBoundingClientRect();
      const lineRects = [...range.getClientRects()];
      return {
        id: element.id,
        lineCount: new Set(
          lineRects.map((line) => Math.round(line.top * 10)),
        ).size,
        width: textBounds.width,
        height: textBounds.height,
        widthRatio: textBounds.width / pageBounds.width,
        heightRatio: textBounds.height / pageBounds.width,
        contentFits: lineRects.every((line) => line.width <= textBounds.width + 0.5),
      };
    }),
  );
}

function assertNormalizedLayouts(layouts, expectedLineCount) {
  assert.deepEqual(
    layouts.map(({ lineCount }) => lineCount),
    layouts.map(() => expectedLineCount),
  );
  const baseline = layouts[0];
  for (const layout of layouts.slice(1)) {
    assert.ok(Math.abs(layout.widthRatio - baseline.widthRatio) < 0.002);
    assert.ok(Math.abs(layout.heightRatio - baseline.heightRatio) < 0.002);
  }
}

function annotationPage(id, width, text, fontScalePercent = 2.4, editing = false) {
  return `
    <div class="annotated-pdf-page" style="width: ${width}px; height: 240px">
      <div class="annotation-overlay"${editing ? " data-editing" : ""}>
        <button
          class="annotation-text"
          id="${id}"
          style="left: 50%; top: 50%; font-size: ${fontScalePercent}cqw"
        >${text}</button>
      </div>
    </div>
  `;
}
