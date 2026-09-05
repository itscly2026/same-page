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
