import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { JoinCodeField } from "./join-code-field";
import { normalizeJoinCodeInput } from "./join-code";

describe("JoinCodeField", () => {
  it("normalizes case, separators, ambiguous characters, and length", () => {
    expect(normalizeJoinCodeInput("abci-0oef 2345")).toBe("ABCEF234");
    expect(normalizeJoinCodeInput("ABCDEFGHJKLM")).toBe("ABCDEFGH");
  });

  it("uses one labelled input while presenting eight decorative slots", () => {
    render(<FieldHarness />);

    const input = screen.getByRole("textbox", { name: "邀请码" });
    expect(screen.getAllByRole("textbox")).toHaveLength(1);

    fireEvent.change(input, { target: { value: "ab cd - efgh" } });

    expect(input).toHaveValue("ABCD-EFGH");
    expect(document.querySelectorAll(".join-code-slot")).toHaveLength(8);
    expect(
      Array.from(document.querySelectorAll(".join-code-slot"), (slot) =>
        slot.textContent,
      ).join(""),
    ).toBe("ABCDEFGH");
    expect(document.querySelector(".join-code-slots")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("keeps ordinary keyboard deletion in the same semantic input", () => {
    render(<FieldHarness initialValue="ABCDEFGH" />);

    const input = screen.getByRole("textbox", { name: "邀请码" });
    fireEvent.change(input, { target: { value: "ABCD-EFG" } });

    expect(input).toHaveValue("ABCD-EFG");
    expect(document.querySelectorAll(".join-code-slot[data-filled]")).toHaveLength(7);
  });
});

function FieldHarness(props: { initialValue?: string }) {
  const [value, setValue] = useState(props.initialValue ?? "");
  return <JoinCodeField value={value} onChange={setValue} />;
}
