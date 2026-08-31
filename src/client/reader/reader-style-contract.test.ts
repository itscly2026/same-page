/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/client/styles.css"), "utf8");

describe("reader control style contract", () => {
  it("uses opaque white bars with black controls", () => {
    expect(styles).toMatch(
      /\.reader-chrome,[\s\S]*?color: #000;[\s\S]*?background: #fff;/,
    );
    expect(styles).toMatch(
      /\.annotation-controls \{[\s\S]*?color: #000;[\s\S]*?background: #fff;/,
    );
    expect(styles).toMatch(
      /\.page-preview-strip \{[\s\S]*?color: #000;[\s\S]*?background: #fff;/,
    );
  });

  it("keeps icon controls at least 44 CSS pixels square", () => {
    expect(styles).toMatch(
      /\.reader-icon-button \{[\s\S]*?width: 2\.75rem;[\s\S]*?min-width: 2\.75rem;/,
    );
    expect(styles).toMatch(
      /\.annotation-controls \.annotation-tool-button,[\s\S]*?width: 2\.75rem;[\s\S]*?min-height: 2\.75rem;/,
    );
  });
});
