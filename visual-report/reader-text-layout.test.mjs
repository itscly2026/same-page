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

test("keeps a text annotation on the same line when the PDF page width doubles", async (context) => {
  const browser = await testBrowser(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  await setFixture(page, `
    ${annotationPage("fit", 556.4, sampleText)}
    ${annotationPage("zoomed", 1112.8, sampleText)}
  `);

  const layouts = await measureTextLayouts(page);
  assert.deepEqual(layouts.map(({ id, lineCount }) => ({ id, lineCount })), [
    { id: "fit", lineCount: 1 },
    { id: "zoomed", lineCount: 1 },
  ]);
});

test("keeps fixed screen-space padding out of text flow geometry", async (context) => {
  const browser = await testBrowser(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const text = "排".repeat(41);

  await setFixture(page, `
    ${annotationPage("fit-small", 556.4, text, 1.2)}
    ${annotationPage("zoomed-small", 1112.8, text, 1.2)}
  `);

  assert.deepEqual(
    (await measureTextLayouts(page)).map(({ lineCount }) => lineCount),
    [1, 1],
  );
});

test("wraps a long unbroken annotation inside stable page-relative bounds", async (context) => {
  const browser = await testBrowser(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const text = "https://samepage.example/rehearsal/tenor-breathe-together-before-entry";

  await setFixture(page, `
    ${annotationPage("fit-url", 556.4, text)}
    ${annotationPage("zoomed-url", 1112.8, text)}
  `);

  const layouts = await measureTextLayouts(page);
  assert.equal(layouts[0].lineCount, layouts[1].lineCount);
  assert.ok(layouts[0].lineCount > 1);
  assert.ok(layouts.every(({ contentFits }) => contentFits));
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

test("preserves normalized wrapping at 100%, 125%, 200% and 300% zoom", async (context) => {
  const browser = await testBrowser(context);
  const page = await browser.newPage({ viewport: { width: 1800, height: 1800 } });
  const cases = [
    ["page-100", 556.4],
    ["page-125", 695.5],
    ["page-200", 1112.8],
    ["page-300", 1669.2],
  ];

  await setFixture(
    page,
    cases.map(([id, width]) => annotationPage(id, width, longChineseText)).join(""),
  );

  assertNormalizedLayouts(await measureTextLayouts(page), 2);
});

test("preserves normalized wrapping in paged and continuous readers across orientation", async (context) => {
  const browser = await testBrowser(context);
  const cases = [
    ["paged-landscape", "paged", { width: 1194, height: 834 }, 556.4],
    ["paged-portrait", "paged", { width: 834, height: 1194 }, 760],
    ["continuous-landscape", "continuous", { width: 1194, height: 834 }, 1194],
    ["continuous-portrait", "continuous", { width: 834, height: 1194 }, 834],
  ];

  const layouts = [];
  for (const [id, layout, viewport, width] of cases) {
    const page = await browser.newPage({ viewport });
    await setFixture(page, readerLayoutPage(id, layout, width, longChineseText));
    layouts.push(...await measureTextLayouts(page));
  }

  assertNormalizedLayouts(layouts, 2);
});

test("preserves explicit line breaks at every page scale", async (context) => {
  const browser = await testBrowser(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const text = "第一排统一\n第二排保持轻声";

  await setFixture(page, `
    ${annotationPage("fit-multiline", 556.4, text)}
    ${annotationPage("zoomed-multiline", 1112.8, text)}
  `);

  assert.deepEqual(
    (await measureTextLayouts(page)).map(({ lineCount }) => lineCount),
    [2, 2],
  );
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

function readerLayoutPage(id, layout, width, text) {
  const page = annotationPage(id, width, text);
  if (layout === "continuous") {
    return `
      <section class="continuous-reader">
        <div class="continuous-reader__inner" style="width: ${width}px; height: 600px">
          <div class="continuous-reader__page">${page}</div>
        </div>
      </section>
    `;
  }
  return `
    <section class="page-reader">
      <div class="page-reader__viewport">
        <div class="page-reader__canvas-stage" style="width: 100vw; height: 100vh">
          <div class="page-reader__pager-window" style="width: ${width}px; height: 240px">
            <div class="page-reader__pager-track">
              <div class="page-reader__sheet" data-page-turn-current>
                <div class="page-reader__content page-reader__paper">${page}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}
