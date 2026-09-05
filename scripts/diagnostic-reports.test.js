import { expect, it } from "vitest";
import { diagnosticInboxQuery } from "./diagnostic-reports.mjs";

it("lists metadata with bounded filters and suppresses expired reports", () => {
  const { sql, mode } = diagnosticInboxQuery(["list", "--remote", "--status", "new", "--build", "abcdef1", "--category", "network"], 100);
  expect(mode).toBe("--remote");
  expect(sql).toContain("expires_at > 100");
  expect(sql).toContain("client_build = 'abcdef1'");
  expect(sql).toContain("json_extract(record.value, '$.category') = 'network'");
  expect(sql).toContain("LIMIT 100");
  expect(sql).not.toContain("SELECT payload");
});
it("show and mark require explicit environment/id and mark does not extend expiry", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(diagnosticInboxQuery(["show", "--local", "--id", id]).sql).toContain("payload FROM");
  const { sql } = diagnosticInboxQuery(["mark", "--remote", "--id", id, "--status", "resolved"], 100);
  expect(sql).toContain("SET status = 'resolved'");
  expect(sql).not.toContain("SET expires_at");
  expect(sql).toContain("expires_at > 100");
});
it("rejects injection and ambiguous/missing command parameters", () => {
  for (const args of [
    ["list"], ["list", "--remote", "--local"], ["show", "--remote"], ["mark", "--remote", "--status", "resolved"],
    ["list", "--remote", "--build", "'; DELETE FROM user; --"], ["list", "--remote", "--category", "secret"],
    ["list", "--remote", "--status", "invalid"], ["show", "--remote", "--id", "abc"], ["list", "--remote", "--unknown"],
  ]) expect(() => diagnosticInboxQuery(args)).toThrow();
});

it("executes inbox filters, view and mark against the actual migration schema", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(new URL("../migrations/0016_diagnostic_reports.sql", import.meta.url), "utf8"));
    const id = "11111111-1111-4111-8111-111111111111";
    const payload = JSON.stringify({ description: "synthetic issue", records: [{ category: "network" }] });
    db.prepare("INSERT INTO diagnostic_reports (id, client_build, payload, payload_hash, created_at, expires_at) VALUES (?, 'abcdef1', ?, 'synthetic', 50, 200)").run(id, payload);
    const run = args => db.prepare(diagnosticInboxQuery(args, 100).sql).all();
    expect(run(["list", "--local", "--category", "network", "--build", "abcdef1"])).toEqual([expect.objectContaining({ id, status: "new" })]);
    expect(run(["list", "--local", "--category", "internal"])).toEqual([]);
    expect(run(["show", "--local", "--id", id])[0].payload).toBe(payload);
    expect(run(["mark", "--local", "--id", id, "--status", "resolved"])).toEqual([{ id, status: "resolved" }]);
    expect(run(["list", "--local", "--status", "new"])).toEqual([]);
    expect(db.prepare(diagnosticInboxQuery(["show", "--local", "--id", id], 200).sql).all()).toEqual([]);
  } finally { db.close(); }
});
