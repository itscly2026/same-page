import { SettingsRequestError } from "../settings/settings-request";
import { NAVIGATION_FRESH_MS } from "../settings/navigation-events";
import { z } from "zod";
import { Button } from "react-aria-components";
import { useReadResource } from "../settings/use-read-resource";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { formatBytes } from "../score-library/library-format";
const schema = z.object({ plan: z.enum(["free", "configured"]), usedBytes: z.number(), limitBytes: z.number(),
  scoreCount: z.number(), scoreLimit: z.number().nullable(), memberCount: z.number(), memberLimit: z.number().nullable() });
export function DriveUsage({ choirId, userId }: { choirId: string; userId: string }) {
  const resource = useReadResource({ owner: userId, driveId: choirId, kind: "usage" }, async signal => {
    const response = await diagnosticFetch(`/api/choirs/${choirId}/usage`, { signal });
    if (!response.ok) throw new SettingsRequestError(response.status);
    return parseDiagnosticResponse(response, schema);
  }, undefined, NAVIGATION_FRESH_MS);
  const data = resource.data;
  return <section className="management-row"><h2>{data?.plan === "free" ? "免费体验版" : "云盘用量"}</h2>
    {data ? <><p>乐谱 {data.scoreCount}{data.scoreLimit !== null ? `/${data.scoreLimit}` : ""} · 空间 {formatBytes(data.usedBytes)} / {formatBytes(data.limitBytes)} · 成员 {data.memberCount}{data.memberLimit !== null ? `/${data.memberLimit}` : ""}</p>
      <p>回收站、历史版本和待确认的 PDF 也占用空间。拥有者可在回收站或历史版本中彻底删除不需要的内容。</p></> : <p role="status">{resource.error ? "暂时无法读取用量。" : "正在读取用量…"}</p>}
    <Button className="secondary-button" onPress={() => void resource.refresh().catch(() => undefined)}>刷新用量</Button>
  </section>;
}
