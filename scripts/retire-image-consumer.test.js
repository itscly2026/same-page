import { expect, it } from "vitest";
import { retireImageConsumer } from "./retire-image-consumer.mjs";

const queueId = "a".repeat(32);
const consumerId = "b".repeat(32);
const target = { type: "worker", script: "same-page", consumer_id: consumerId };
function cloud({ queues = [{ queue_name: "same-page-images", queue_id: queueId }], consumers = [target], fail, retain = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method });
    if (fail) return fail(path, init);
    if (path.endsWith(`/consumers/${consumerId}`) && init.method === "DELETE") {
      if (!retain) consumers = consumers.filter(row => row.consumer_id !== consumerId);
      return Response.json({ success: true });
    }
    if (path.endsWith("/consumers")) return Response.json({ success: true, result: consumers });
    return Response.json({ success: true, result: queues, result_info: { page: 1, total_pages: 1 } });
  };
  return { requests, run: () => retireImageConsumer({ accountId: "c".repeat(32), token: "fixture-token", fetchImpl }) };
}
it("removes the retired consumer before deployment and a repeated release is a no-op", async () => {
  const api = cloud();
  expect(await api.run()).toBe("removed");
  expect(await api.run()).toBe("already-absent");
  expect(api.requests.filter(row => row.method === "DELETE")).toEqual([
    { path: `/client/v4/accounts/${"c".repeat(32)}/queues/${queueId}/consumers/${consumerId}`, method: "DELETE" },
  ]);
});
it.each([
  { queues: [] },
  { queues: [{ queue_name: "same-page-images-backup", queue_id: queueId }] },
  { consumers: [{ ...target, script: "other-worker" }] },
  { consumers: [{ type: "http_pull", consumer_id: consumerId }] },
])("leaves absent or unrelated resources alone: %j", async options => {
  const api = cloud(options);
  expect(await api.run()).toBe("already-absent");
  expect(api.requests.every(row => row.method === "GET")).toBe(true);
});
it.each([401, 403, 404, 429, 500])("does not mistake HTTP %s for successful retirement", async status => {
  const api = cloud({ fail: () => Response.json({ success: false, errors: [{ message: "fixture-token" }] }, { status }) });
  await expect(api.run()).rejects.toThrow(`HTTP ${status}`);
  await expect(api.run()).rejects.not.toThrow("fixture-token");
});
it("requires confirmed removal rather than trusting the DELETE response", async () => {
  await expect(cloud({ retain: true }).run()).rejects.toThrow(/still attached/);
});
it.each([null, {}, { success: false }, { success: true, result: {} }])("fails closed on malformed API responses: %j", async body => {
  await expect(cloud({ fail: () => Response.json(body) }).run()).rejects.toThrow();
});
it("redacts transport failures", async () => {
  await expect(retireImageConsumer({ accountId: "c".repeat(32), token: "fixture-token", fetchImpl: async () => { throw new Error("fixture-token"); } })).rejects.toThrow("Queue API transport failure");
});
it("finds the exact retired queue on a later API page", async () => {
  const calls = [];
  const fetchImpl = async url => {
    const parsed = new URL(url);
    calls.push(parsed.searchParams.get("page"));
    if (parsed.pathname.endsWith("/consumers")) return Response.json({ success: true, result: [] });
    const page = Number(parsed.searchParams.get("page"));
    return Response.json({ success: true, result: page === 1 ? [] : [{ queue_name: "same-page-images", queue_id: queueId }], result_info: { page, total_pages: 2 } });
  };
  expect(await retireImageConsumer({ accountId: "c".repeat(32), token: "fixture", fetchImpl })).toBe("already-absent");
  expect(calls).toEqual(["1", "2", null]);
});
it("refuses consumers without a known Worker identity", async () => {
  await expect(cloud({ consumers: [{ type: "worker", consumer_id: consumerId }] }).run()).rejects.toThrow(/identity/);
});
it("propagates DELETE rejection without continuing to deployment", async () => {
  const fetchImpl = async (url, init) => {
    if (init.method === "DELETE") return Response.json({ success: false }, { status: 403 });
    return Response.json({ success: true, result: String(url).endsWith("/consumers") ? [target] : [{ queue_name: "same-page-images", queue_id: queueId }] });
  };
  await expect(retireImageConsumer({ accountId: "c".repeat(32), token: "fixture", fetchImpl })).rejects.toThrow("HTTP 403");
});
