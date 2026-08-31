// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  formatSuccessMessage,
  parseArguments,
} from "./provision-choir.mjs";

describe("choir provisioning output", () => {
  const baseArguments = [
    "--admin-email",
    "admin@example.test",
    "--admin-display-name",
    "管理员",
  ];

  it("does not print the initial invite code by default", () => {
    const options = parseArguments(baseArguments);
    const message = formatSuccessMessage("ABCDEFGH", options.showJoinCode);

    expect(options.showJoinCode).toBe(false);
    expect(options.guestAdmission).toBe("invite");
    expect(options.previewEntry).toBe(false);
    expect(message).not.toContain("ABCDEFGH");
    expect(message).toContain("was not displayed");
  });

  it("only prints the code after an explicit operator flag", () => {
    const options = parseArguments([...baseArguments, "--show-join-code"]);

    expect(options.showJoinCode).toBe(true);
    expect(formatSuccessMessage("ABCDEFGH", options.showJoinCode)).toContain(
      "ABCDEFGH",
    );
  });

  it("creates a choir with open guest admission without an invite code", () => {
    const options = parseArguments([
      ...baseArguments,
      "--guest-admission",
      "open",
      "--show-join-code",
    ]);

    expect(options.guestAdmission).toBe("open");
    expect(
      formatSuccessMessage(
        null,
        options.showJoinCode,
        options.guestAdmission,
      ),
    ).toBe("Choir created with open guest admission.\n");
  });

  it("marks one open-admission choir as the preview entry", () => {
    const options = parseArguments([
      ...baseArguments,
      "--guest-admission",
      "open",
      "--preview-entry",
    ]);

    expect(options.previewEntry).toBe(true);
  });

  it("does not allow an invite choir to become the preview entry", () => {
    expect(() =>
      parseArguments([...baseArguments, "--preview-entry"]),
    ).toThrow("--preview-entry requires --guest-admission open");
  });

  it("rejects an unknown guest admission mode", () => {
    expect(() =>
      parseArguments([...baseArguments, "--guest-admission", "demo"]),
    ).toThrow("--guest-admission must be invite or open");
  });
});
