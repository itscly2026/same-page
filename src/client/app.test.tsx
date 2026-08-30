import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppRoutes } from "./app";

vi.mock("./auth/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: null, isPending: false }),
    signOut: vi.fn(),
  },
}));

describe("AppRoutes", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choir: { id: "choir-1", name: "小红花合唱团" },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens with a read-only guest entry and no public choir creation", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "让每次排练，都在同一页" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("八位邀请码")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "访客进入" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("创建合唱团")).not.toBeInTheDocument();
  });

  it("uses the guest session response to enter a choir", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("八位邀请码"), {
      target: { value: "AAAAAAAA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "访客进入" }));

    expect(
      await screen.findByRole("heading", { name: "小红花合唱团" }),
    ).toBeInTheDocument();
  });
});
