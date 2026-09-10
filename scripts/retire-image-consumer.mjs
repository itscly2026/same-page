import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// Operational retirement for #156: delete only the old subscription, never the
// queue or its messages. The caller holds the production release lock.
export async function retireImageConsumer({ accountId, token, fetchImpl = fetch }) {
  assert(/^[a-f0-9]{32}$/.test(accountId ?? "") && token, "Cloudflare account and token are required");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues`;
  async function request(path, method = "GET") {
    let response;
    let body;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method, headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      body = await response.json();
    } catch {
      throw new Error("Queue API transport failure");
    }
    // Never include the response body, URL, or raw exception in release logs.
    assert(response.ok && body?.success === true, `Queue API failed (HTTP ${response.status})`);
    if (method === "GET") assert(Array.isArray(body.result), "Invalid Queue API result");
    return body;
  }
  let queue;
  for (let page = 1; ; page++) {
    assert(page <= 100, "Queue listing exceeded the retirement scan limit");
    const body = await request(`?page=${page}&per_page=100`);
    for (const row of body.result) {
      assert(row && typeof row.queue_name === "string", "Invalid queue identity");
      if (row.queue_name !== "same-page-images") continue;
      assert(!queue && /^[a-f0-9]{32}$/.test(row.queue_id), "Invalid or duplicate retired queue");
      queue = row;
    }
    const totalPages = body.result_info?.total_pages;
    if (totalPages !== undefined) {
      assert(Number.isInteger(totalPages) && totalPages >= 0, "Invalid queue pagination");
      if (page >= totalPages) break;
    } else if (body.result.length < 100) break;
  }
  if (!queue) return "already-absent";
  const consumerPath = `/${queue.queue_id}/consumers`;
  const findTarget = async () => {
    const { result } = await request(consumerPath);
    for (const row of result) {
      assert(row && ["worker", "http_pull"].includes(row.type), "Invalid consumer identity");
      if (row.type === "worker") assert(typeof row.script === "string" && row.script.length > 0, "Missing consumer Worker identity");
    }
    const matches = result.filter(row => row.type === "worker" && row.script === "same-page");
    assert(matches.length <= 1, "Multiple retired consumers found");
    return matches[0];
  };
  const consumer = await findTarget();
  if (!consumer) return "already-absent";
  assert(/^[a-f0-9]{32}$/.test(consumer.consumer_id), "Invalid retired consumer ID");
  await request(`${consumerPath}/${consumer.consumer_id}`, "DELETE");
  assert(!await findTarget(), "Retired image consumer is still attached");
  return "removed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await retireImageConsumer({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    });
    console.log(`Retired image consumer: ${result}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
