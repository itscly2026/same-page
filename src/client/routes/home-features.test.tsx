import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppRoutes } from "../app";
import offlineSyncAnimation from "../assets/home/offline-sync-animation.webp";
import offlineSyncIllustration from "../assets/home/offline-sync.webp";

vi.mock("../auth/auth-client", () => ({ authClient: {
  useSession: vi.fn(() => ({ data: null, isPending: false })),
  signOut: vi.fn(),
  signIn: { email: vi.fn(), social: vi.fn() },
} }));

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
});

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function renderFeatures() {
  render(<MemoryRouter initialEntries={["/"]}><AppRoutes /></MemoryRouter>);
  await screen.findByRole("heading", { name: "离线可用，联网同步" });
  return within(screen.getByRole("region", { name: "产品特点" }));
}

it("animates the first four features while keeping the fifth illustration static", async () => {
  const features = await renderFeatures();
  expect(features.getAllByRole("article")).toHaveLength(5);
  expect(features.getAllByRole("button")).toHaveLength(4);
  for (const title of [
    "不同声部，分层共享笔记",
    "共享笔记按需看，个人笔记自己留",
    "替换乐谱，保留笔记",
    "离线可用，联网同步",
  ]) {
    expect(features.getByRole("button", { name: `播放演示：${title}` })).toBeInTheDocument();
  }
  const poster = features.getByRole("img", { name: "离线可用，联网同步" });
  expect(poster).toHaveAttribute("src", offlineSyncIllustration);
  expect(poster).toHaveAttribute("width", "768");
  expect(poster).toHaveAttribute("height", "512");
  expect(features.queryByRole("button", { name: /一份乐谱，多设备可用/ })).not.toBeInTheDocument();
});

it("requests the offline-sync WebP on replay and retains its poster if loading fails", async () => {
  const features = await renderFeatures();
  fireEvent.click(features.getByRole("button", { name: "播放演示：离线可用，联网同步" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(offlineSyncAnimation, {
    signal: expect.any(AbortSignal),
  }));
  expect(features.getByRole("img", { name: "离线可用，联网同步" }))
    .toHaveAttribute("src", offlineSyncIllustration);
  expect(features.getByRole("button", { name: "重播：离线可用，联网同步" })).toBeInTheDocument();
});
