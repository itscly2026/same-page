// @vitest-environment node

import { describe, expect, it } from "vitest";

import { scoreFileNameKey } from "../src/shared/scores.ts";
import { canonicalScoreFileNameKey } from "../src/shared/score-file-name-key.mjs";
import { planLegacyScoreFileNames } from "./backfill-score-file-names.mjs";

describe("legacy score filename migration", () => {
  it("uses the same Unicode key as the application", () => {
    const decomposedName = "E\u0301TÉ.PDF";
    expect(canonicalScoreFileNameKey(decomposedName)).toBe("été.pdf");
    expect(canonicalScoreFileNameKey(decomposedName)).toBe(
      scoreFileNameKey(decomposedName),
    );
  });

  it("disambiguates legacy duplicates in stable creation order", () => {
    const planned = planLegacyScoreFileNames([
      {
        id: "second",
        choir_id: "choir",
        file_name: "E\u0301TÉ",
        file_name_key: "legacy-score:second",
        created_at: 2,
      },
      {
        id: "first",
        choir_id: "choir",
        file_name: "Été",
        file_name_key: "legacy-score:first",
        created_at: 1,
      },
    ]);

    expect(planned).toEqual([
      {
        id: "first",
        choirId: "choir",
        fileName: "Été.pdf",
        fileNameKey: "été.pdf",
      },
      {
        id: "second",
        choirId: "choir",
        fileName: "ÉTÉ (2).pdf",
        fileNameKey: "été (2).pdf",
      },
    ]);
  });

  it("leaves filenames that were already migrated untouched", () => {
    expect(
      planLegacyScoreFileNames([
        {
          id: "active",
          choir_id: "choir",
          file_name: "Current.pdf",
          file_name_key: "current.pdf",
          created_at: 1,
        },
        {
          id: "trashed",
          choir_id: "choir",
          file_name: "Current.pdf",
          file_name_key: "current.pdf",
          created_at: 2,
        },
      ]),
    ).toEqual([]);
  });
});
