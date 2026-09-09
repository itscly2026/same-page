import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

import { startVisualServer } from "./setup.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
let server;
let origin = process.env.LAYOUT_TEST_ORIGIN;

before(async () => {
  if (!origin) {
    server = await startVisualServer({ script: "dev", cwd: repositoryRoot });
    origin = server.origin;
  }
});

after(async () => {
  await server?.stop();
});

for (const [engineName, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  test(
    `${engineName}: homepage features reflow without horizontal scrolling`,
    async (t) => {
      const browser = await engine.launch({ headless: true });
      t.after(() => browser.close());
      const { context, page } = await openGuestPage(browser, engineName === "webkit" ? { isMobile: true, hasTouch: true } : {});
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      await page.getByRole("region", { name: "产品特点" }).waitFor();

      for (const width of [320, 720, 721, 1024]) {
        await page.setViewportSize({ width, height: 1000 });
        const layout = await readHomepageLayout(page);
        assert.equal(layout.viewportWidth, width, "the page viewport must respect the device width");
        assertPageFits(layout, `${engineName} ${width}px`);
      }

      await page.setViewportSize({ width: 834, height: 1194 });
      await enlargeText(page);
      assertPageFits(
        await readHomepageLayout(page),
        `${engineName} iPad-size 200% text`,
      );
      await context.close();
    },
  );
}

async function enlargeText(page) {
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
}

async function readHomepageLayout(page) {
  return page.evaluate(() => {
    const featureElements = [...document.querySelectorAll(".marketing-feature")];
    const visibleWidth = window.visualViewport?.width ?? window.innerWidth;
    const measuredElements = featureElements.flatMap((feature) => [
      feature,
      ...feature.querySelectorAll(
        ".marketing-feature__copy, .marketing-feature__illustration, h2, p",
      ),
    ]);
    return {
      viewportWidth: window.innerWidth,
      visualViewportWidth: visibleWidth,
      documentWidth: document.documentElement.scrollWidth,
      overlaps: featureElements.some(feature => {
        const a = feature.querySelector(".marketing-feature__copy").getBoundingClientRect();
        const b = feature.querySelector(".marketing-feature__illustration").getBoundingClientRect();
        return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      }),
      outsideViewport: measuredElements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            className:
              typeof element.className === "string" ? element.className : "",
            text:
              element.textContent?.trim().replace(/\s+/g, " ").slice(0, 60) ??
              "",
            left: rect.left,
            right: rect.right,
            width: rect.width,
            height: rect.height,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
          };
        })
        .filter(
          ({ left, right, width, height, clientWidth, scrollWidth }) =>
            left < -0.5 ||
            right > visibleWidth + 0.5 ||
            width <= 0 ||
            height <= 0 ||
            scrollWidth > clientWidth + 1,
        ),
    };
  });
}

function assertPageFits(layout, label) {
  assert.equal(layout.overlaps, false, `${label}: illustration obscures feature text`);
  assert.ok(
    layout.documentWidth <= layout.viewportWidth,
    `${label}: layout viewport overflow ${JSON.stringify(layout)}`,
  );
  assert.ok(
    layout.documentWidth <= layout.visualViewportWidth,
    `${label}: visual viewport overflow ${JSON.stringify(layout)}`,
  );
  assert.deepEqual(
    layout.outsideViewport,
    [],
    `${label}: feature content leaves its viewport`,
  );
}

async function openGuestPage(browser, contextOptions = {}) {
  const context = await browser.newContext({
    ...contextOptions,
    serviceWorkers: "block",
    locale: "zh-CN",
    colorScheme: "light",
  });
  await context.route("**/api/**", (route) =>
    route.fulfill(
      resolveFixtureRequest({
        pathname: new URL(route.request().url()).pathname,
        method: route.request().method(),
        identity: "guest",
        cookie: route.request().headers().cookie ?? "",
      }),
    ),
  );
  return { context, page: await context.newPage() };
}
