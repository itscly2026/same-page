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

test("only explicit line breaks remain proportional across zoom", async context => {
  const browser = await testBrowser(context);
  const page = await browser.newPage({ viewport: { width: 1800, height: 1800 } });
  for (const [name, text, font] of [
    ["short", sampleText, 2.4],
    ["small-padding", "排".repeat(41), 1.2],
    ["chinese", longChineseText, 2.4],
    ["explicit-break", "第一排统一\n第二排保持轻声", 2.4],
    ["unbroken-url", "https://samepage.example/rehearsal/tenor-breathe-together-before-entry", 2.4],
  ]) {
    await setFixture(page, [556.4, 695.5, 1112.8, 1669.2]
      .map((width, i) => annotationPage(name + i, width, text, font)).join(""));
    const layouts = await measureTextLayouts(page);
    // Font metrics vary by OS. Preserve wrapping through our responsive CSS,
    // without prescribing an exact number of Chinese glyphs on each line.
    assert.equal(layouts[0].lineCount, name === "explicit-break" ? 2 : 1, name);
    assert.deepEqual(layouts.map(layout => layout.lineCount), layouts.map(() => layouts[0].lineCount), name);
    if (name === "chinese") assertNormalizedLayouts(layouts);
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

test("aligns explicit lines around the same anchor and lets long lines extend past the page", async context => {
  const browser = await testBrowser(context);
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  for (const align of ["left", "center", "right"]) {
    await setFixture(page, annotationPage("aligned", 600, "长的一行提示\n短句", 2.4));
    const result = await page.locator("#aligned").evaluate((element, align) => {
      element.style.textAlign = align;
      const node = element.firstChild;
      const index = node.textContent.indexOf("\n");
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, index);
      const first = range.getBoundingClientRect();
      range.setStart(node, index + 1); range.setEnd(node, node.textContent.length);
      const second = range.getBoundingClientRect();
      const value = box => align === "left" ? box.left : align === "right" ? box.right : (box.left + box.right) / 2;
      const box = element.getBoundingClientRect();
      const parent = element.parentElement.getBoundingClientRect();
      return { lineDelta: value(first) - value(second), anchorDelta: (box.left + box.right) / 2 - (parent.left + parent.right) / 2 };
    }, align);
    assert.ok(Math.abs(result.lineDelta) < 1, align);
    assert.ok(Math.abs(result.anchorDelta) < 1, align);
  }
  await setFixture(page, annotationPage("overflow", 600, "不自动换行".repeat(30), 2.4));
  await page.locator("#overflow").evaluate(element => { element.style.left = "98%"; });
  const [layout] = await measureTextLayouts(page);
  assert.equal(layout.lineCount, 1);
  assert.ok(layout.width > 600);
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
        fontRatio: parseFloat(getComputedStyle(element).fontSize) / pageBounds.width,
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

function assertNormalizedLayouts(layouts) {
  const baseline = layouts[0];
  for (const layout of layouts.slice(1)) {
    // Natural text width includes OS font optical sizing. The baseline stylesheet
    // with no-wrap produces the same 1.4% CJK width variation on macOS WebKit.
    // Check the actual scalable inputs, not a formerly fixed CSS box width.
    assert.ok(Math.abs(layout.fontRatio - baseline.fontRatio) < 0.00001);
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
