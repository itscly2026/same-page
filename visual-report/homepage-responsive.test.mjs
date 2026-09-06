import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright";

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
      const { context, page } = await openGuestPage(browser);
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      await page.getByRole("region", { name: "产品特点" }).waitFor();

      for (const width of [320, 390, 600, 720, 721, 744, 768, 834, 1024]) {
        await page.setViewportSize({ width, height: 1000 });
        const layout = await readHomepageLayout(page);
        assertPageFits(layout, `${engineName} ${width}px`);
        if (width === 720) assert.equal(layout.featureDisplay, "flex");
        if (width === 721) assert.equal(layout.featureDisplay, "grid");
      }

      await page.setViewportSize({ width: 834, height: 1194 });
      await enlargeText(page);
      assertEnlargedLayout(
        await readHomepageLayout(page),
        `${engineName} iPad-size 200% text`,
      );
      await context.close();
    },
  );
}

// Distinct mobile viewport/orientation behavior; desktop width sweeps above
// already cover the remaining presets without repeating identical page loads.
const iPadProfiles = [
  "iPad Mini",
  "iPad Pro 11 landscape",
];

test("webkit: homepage features fit iPad profiles at default and 200% text", async (t) => {
  const browser = await webkit.launch({ headless: true });
  t.after(() => browser.close());

  for (const deviceName of iPadProfiles) {
    const { context, page } = await openGuestPage(browser, devices[deviceName]);
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("region", { name: "产品特点" }).waitFor();

    const defaultLayout = await readHomepageLayout(page);
    assertPageFits(defaultLayout, deviceName);
    assertResponsiveDefaultLayout(defaultLayout, deviceName);

    await enlargeText(page);
    assertEnlargedLayout(
      await readHomepageLayout(page),
      `${deviceName} 200% text`,
    );
    await context.close();
  }
});

async function enlargeText(page) {
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
}

async function readHomepageLayout(page) {
  return page.evaluate(() => {
    const featureElements = [...document.querySelectorAll(".marketing-feature")];
    const featureDisplay = getComputedStyle(featureElements[0]).display;
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
      featureDisplay,
      features: featureElements.map((feature) => {
        const copy = feature.querySelector(".marketing-feature__copy");
        const illustration = feature.querySelector(
          ".marketing-feature__illustration",
        );
        return {
          copyLeft: copy.getBoundingClientRect().left,
          illustrationLeft: illustration.getBoundingClientRect().left,
        };
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

function assertResponsiveDefaultLayout(layout, label) {
  const shouldUseGrid = layout.viewportWidth > 720;
  assert.equal(
    layout.featureDisplay,
    shouldUseGrid ? "grid" : "flex",
    `${label}: default layout`,
  );
  if (!shouldUseGrid) return;
  assert.ok(
    layout.features[0].copyLeft < layout.features[0].illustrationLeft,
    `${label}: first feature is not copy then illustration`,
  );
  assert.ok(
    layout.features[1].illustrationLeft < layout.features[1].copyLeft,
    `${label}: second feature is not illustration then copy`,
  );
}

function assertEnlargedLayout(layout, label) {
  assertPageFits(layout, label);
  assert.equal(layout.featureDisplay, "flex", `${label}: enlarged layout`);
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
