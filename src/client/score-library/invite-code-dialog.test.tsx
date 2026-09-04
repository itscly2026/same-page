import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InviteCodeDialog } from "./invite-code-dialog";

afterEach(() => vi.unstubAllGlobals());

describe("current invite code", () => {
  it("restores a retained original without rotating it", async () => {
    const fetchMock = vi.fn().mockImplementation((_input: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "PUT"
        ? new Response(null, { status: 204 })
        : Response.json({ joinCode: null })),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<InviteCodeDialog choirId="drive" onClose={() => {}} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "邀请码" }), { target: { value: "ABCDEFGH" } });
    fireEvent.click(screen.getByRole("button", { name: "保存原邀请码" }));
    expect(await screen.findByLabelText("当前有效邀请码")).toHaveTextContent("ABCDEFGH");
    expect(fetchMock).toHaveBeenCalledWith("/api/choirs/drive/join-code", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ joinCode: "ABCDEFGH" }),
    });
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("rotate"), expect.anything());
  });

  it("keeps a mismatched original out of the current code display", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_input: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "PUT"
        ? Response.json({ error: "join_code_mismatch" }, { status: 409 })
        : Response.json({ joinCode: null })),
    ));
    render(<InviteCodeDialog choirId="drive" onClose={() => {}} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "邀请码" }), { target: { value: "ABCDEFGH" } });
    fireEvent.click(screen.getByRole("button", { name: "保存原邀请码" }));
    expect(await screen.findByRole("status")).toHaveTextContent("输入的原码与当前有效邀请码不一致。");
    expect(screen.queryByLabelText("当前有效邀请码")).not.toBeInTheDocument();
  });

  it("retries a read failure without treating it as a missing original", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ joinCode: "ABCDEFGH" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InviteCodeDialog choirId="drive" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("暂时无法读取邀请码"));
    expect(screen.queryByRole("button", { name: "保存原邀请码" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "轮换邀请码" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByLabelText("当前有效邀请码")).toHaveTextContent("ABCDEFGH");
  });
});
