import { afterEach, expect, it, vi } from "vitest";
import { deliverInviteCard } from "./save-invite-card";
const file = new File(["fixture"], "invite.png", { type: "image/png" });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("shares the image file through the system share sheet", async () => {
  const share = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { canShare: () => true, share });
  expect(await deliverInviteCard(file, true)).toBe("shared");
  expect(share).toHaveBeenCalledWith({ files: [file] });
});
it("treats dismissal as cancellation without downloading", async () => {
  vi.stubGlobal("navigator", { canShare: () => true, share: vi.fn().mockRejectedValue(new DOMException("cancel", "AbortError")) });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  expect(await deliverInviteCard(file, true)).toBe("cancelled");
  expect(click).not.toHaveBeenCalled();
});
it.each([false, true])("downloads when file sharing is unsupported or blocked (%s)", async blocked => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { canShare: () => blocked, share: vi.fn().mockRejectedValue(new DOMException("blocked", "NotAllowedError")) });
  vi.stubGlobal("URL", { createObjectURL: () => "blob:fixture", revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe("invite.png");
  });
  expect(await deliverInviteCard(file, true)).toBe("saved");
  expect(click).toHaveBeenCalledOnce();
  await vi.runAllTimersAsync();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture");
});
