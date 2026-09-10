import { localDatabase } from "../platform/local-database";
import { beforeEach, expect, it, vi } from "vitest";
import { activateAuthenticatedLocalOwner, captureLocalWorkspaceSession, createLocalWorkspace, authenticatedLocalOwnerKey } from "../platform/local-workspace";
import { ReaderAnnotationActions } from "./reader-annotation-actions";

beforeEach(async () => { await localDatabase.open(); await activateAuthenticatedLocalOwner("one"); });
async function actions(overrides = {}) {
  const workspace = await captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey("one"), "drive", "score"));
  return { workspace, actions: new ReaderAnnotationActions(workspace, { authenticated: false, online: false, trashed: false, confirmIdentity: vi.fn().mockResolvedValue(null), ...overrides }) };
}
it("suppresses a late retry result after the reader exits, including an immediate restart", async () => {
  let confirm!: () => void;
  const { actions: sync } = await actions({ confirmIdentity: () => new Promise<void>(resolve => { confirm = resolve; }) });
  const retry = sync.retry();
  await vi.waitFor(() => expect(confirm).toBeTypeOf("function"));
  sync.stop(); sync.start(); confirm();
  expect(await retry).toBeNull();
});
it("preserves trashed-score drafts without attempting synchronization", async () => {
  const { actions: sync } = await actions({ authenticated: true, online: true, trashed: true });
  expect(await sync.retry()).toBe("trash-preserved");
});
