import { beforeEach, expect, it, vi } from "vitest";
import { ReaderSession } from "./reader-session";
import { localDatabase } from "../platform/local-database";
import { resolveLocalWorkspace } from "../platform/local-workspace";
import { loadPdfDocument } from "./pdf-document";
import { clearReaderDocumentCache } from "./reader-document-cache";
import { afterEach } from "vitest";

vi.mock("./pdf-document", () => ({ loadPdfDocument: vi.fn(() => ({ promise: new Promise(() => {}), destroy: vi.fn().mockResolvedValue(undefined) })) }));
beforeEach(async () => { await localDatabase.open(); });
afterEach(() => { clearReaderDocumentCache(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("disposal makes a delayed cloud result and a late PDF incapable of publishing", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "drive", scoreId: "score" });
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const session = new ReaderSession(workspace, null);
  const observer = vi.fn();
  session.subscribe(observer);
  session.open();
  await vi.waitFor(() => expect(loadPdfDocument).toHaveBeenCalled());
  session.dispose();
  const last = session.getSnapshot();
  const count = observer.mock.calls.length;
  finish(new Response(null, { status: 403 }));
  await Promise.resolve();
  await Promise.resolve();
  expect(session.getSnapshot()).toBe(last);
  expect(observer).toHaveBeenCalledTimes(count);
});

it("repeated foreground refreshes share one pending confirmation", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "drive", scoreId: "score" });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetch);
  const session = new ReaderSession(workspace, null);
  const first = session.refresh();
  for (let index = 0; index < 20; index++) expect(session.refresh()).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(1);
  session.dispose();
});
