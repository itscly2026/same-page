/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/client/styles.css"), "utf8");

describe("reader control style contract", () => {
  it("centers fitted pages without changing oversized-page scrolling", () => {
    expect(styles).toMatch(
      /\.page-reader__canvas-stage \{[\s\S]*?place-items: center;/,
    );
    expect(styles).toMatch(
      /\.continuous-reader__page \{[\s\S]*?justify-content: safe center;/,
    );
  });

  it("moves a paper track across a distinct black page gutter", () => {
    expect(styles).toMatch(
      /\.page-reader__pager-track \{[\s\S]*?translate3d\(var\(--page-turn-offset, 0px\)/,
    );
    expect(styles).toMatch(
      /\.page-reader__pager-window \{[\s\S]*?overflow: clip/,
    );
    expect(styles).toMatch(
      /\.page-reader__pager-window\[data-gesture-preview\] \{[\s\S]*?overflow: visible/,
    );
    expect(styles).toMatch(
      /\.page-reader__pager-window\[data-gesture-preview\][\s\S]*?\.page-reader__sheet:not\(\[data-page-turn-current\]\)[\s\S]*?visibility: hidden/,
    );
    expect(styles).toMatch(
      /\.page-reader__pager-track\[data-page-turn-phase="settling"\] \{[\s\S]*?transition: transform 240ms/,
    );
    expect(styles).toMatch(
      /\.page-reader__gutter \{[\s\S]*?width: 14px;[\s\S]*?background: #050505;/,
    );
  });

  it("uses compact floating reader controls instead of a full-width white bar", () => {
    expect(styles).toMatch(
      /\.reader-chrome \{[\s\S]*?pointer-events: none;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/,
    );
    expect(styles).toMatch(
      /\.reader-chrome__back,\s*\.reader-chrome__actions \{[\s\S]*?background: rgb\(255 255 255 \/ 96%\);/,
    );
    expect(styles).toMatch(
      /\.reader-shell::before \{[\s\S]*?pointer-events: none;[\s\S]*?z-index: 10;[\s\S]*?linear-gradient\([\s\S]*?transparent 100%[\s\S]*?opacity: 0;/,
    );
    expect(styles).toMatch(
      /\.reader-shell\[data-chrome-visible\]::before \{\s*opacity: 1;/,
    );
    expect(styles).toMatch(
      /\.reader-more-menu \{[\s\S]*?pointer-events: auto;/,
    );
    expect(styles).toMatch(
      /\.annotation-controls \{[\s\S]*?left: 50%;[\s\S]*?width: max-content;[\s\S]*?overflow-x: auto;[\s\S]*?background: #fff;[\s\S]*?transform: translateX\(-50%\);/,
    );
    expect(styles).toMatch(
      /\.page-preview-strip \{[\s\S]*?color: #000;[\s\S]*?background: #fff;/,
    );
    const titleRules = styles.match(/\.reader-chrome__title \{([^}]*)\}/)?.[1] ?? "";
    expect(titleRules).toMatch(/max-width:[\s\S]*?text-align: center;/);
    expect(titleRules).not.toMatch(/background|border|box-shadow|padding/);
  });

  it("keeps icon controls at least 44 CSS pixels square", () => {
    expect(styles).toMatch(
      /\.reader-icon-button \{[\s\S]*?width: 2\.75rem;[\s\S]*?min-width: 2\.75rem;/,
    );
    expect(styles).toMatch(
      /\.annotation-controls \.annotation-layer-slot,\s*\.annotation-controls \.annotation-tool-button \{[\s\S]*?min-width: 2\.75rem;[\s\S]*?width: 2\.75rem;[\s\S]*?min-height: 2\.75rem;/,
    );
    expect(styles).toMatch(
      /\.reader-chrome button\[aria-pressed="true"\],[\s\S]*?color: #fff;[\s\S]*?background: #111;/,
    );
  });

  it("renders completed text as pure text while keeping a dimmed input composer", () => {
    expect(styles).toMatch(
      /\.annotation-text \{[\s\S]*?background: transparent;/,
    );
    expect(styles).toMatch(
      /\.annotation-text-composer\[data-active\] \{[\s\S]*?background: rgb\(34 34 34 \/ 28%\);/,
    );
    expect(styles).toMatch(
      /\.annotation-font-scale__track \{[\s\S]*?clip-path: polygon\(0 0, 100% 0, 50% 100%\);/,
    );
    expect(styles).toMatch(
      /\.annotation-delete-zone \{[\s\S]*?border-radius: 50%;[\s\S]*?background: rgb\(218 216 217 \/ 72%\);/,
    );
    expect(styles).not.toMatch(
      /\.annotation-delete-zone\[data-active\][\s\S]*?#b4233f/,
    );
  });
});
