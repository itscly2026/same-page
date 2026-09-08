import { useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { Link, useParams } from "react-router-dom";
import { LockKeyhole } from "lucide-react";
import { authClient } from "../auth/auth-client";
import { AppHeader } from "../components/app-header";
import { BackButton } from "../navigation/back-button";
import { driveManagementSchema } from "../../shared/drive-management";
import { managedMembershipsSchema } from "../../shared/lifecycle";
import { operationLabels, type Operation } from "../../shared/drive-permissions";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { SettingsRequestError, settingsError } from "../settings/settings-request";
import { DriveSettingsDialog } from "../score-library/drive-settings-dialog";
import { InviteCodeDialog } from "../score-library/invite-code-dialog";
import { TrashDialog } from "../score-library/trash-dialog";

type Overview = ReturnType<typeof driveManagementSchema.parse>;
type Members = ReturnType<typeof managedMembershipsSchema.parse>;
export default function DriveManagementPage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <DriveManagement key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} />;
}
function DriveManagement({ choirId }: { choirId: string }) {
  const [data, setData] = useState<{ overview: Overview; members: Members } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<"name" | "invite" | "trash" | null>(null);
  const [locked, setLocked] = useState<Operation | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const [overviewResponse, membersResponse] = await Promise.all([
        diagnosticFetch(`/api/choirs/${choirId}/management`, { signal: controller.signal }),
        diagnosticFetch(`/api/choirs/${choirId}/memberships`, { signal: controller.signal }),
      ]);
      for (const response of [overviewResponse, membersResponse]) if (!response.ok) throw new SettingsRequestError(response.status);
      const overview = await parseDiagnosticResponse(overviewResponse, driveManagementSchema);
      const members = await parseDiagnosticResponse(membersResponse, managedMembershipsSchema);
      if (!controller.signal.aborted) { setData({ overview, members }); setError(null); }
    }
    void load().catch(error => { if (!controller.signal.aborted) { setData(null); setError(settingsError(error, "管理概览加载失败，请联网后重试。")); } });
    return () => controller.abort();
  }, [choirId, attempt]);
  const refresh = () => { setData(null); setError(null); setDialog(null); setLocked(null); setAttempt(value => value + 1); };
  const can = (operation: Operation) => data?.overview.capabilities.operations.operations.includes(operation);
  function action(label: string, operation: Operation, open: () => void, href?: string) {
    return can(operation) && href ? <Link className="settings-secondary-link" to={href}>{label}</Link> : <Button className="settings-secondary-link" onPress={() => { if (can(operation)) open(); else setLocked(operation); }}>{!can(operation) && <LockKeyhole size={16} aria-label="无操作权限" />}{label}</Button>;
  }
  return <div className="app-page"><AppHeader actions={<BackButton className="header-action" to={`/choirs/${choirId}`}>返回</BackButton>} /><main className="page-shell settings-page settings-ux">
    <header className="settings-heading"><h1>云盘管理</h1><p>成员可以了解云盘配置；修改按各项权限分别控制。</p></header>
    {!data && <p role={error ? "alert" : "status"}>{error ?? "正在读取管理概览…"}</p>}
    {error && <Button className="secondary-button" onPress={refresh}>重新读取</Button>}
    {data && <>
      <section><h2>{data.overview.name}</h2>{action("修改云盘名称", "editDriveInfo", () => setDialog("name"))}<p>访客准入：{data.overview.guestAdmissionMode === "open" ? "开放进入" : "需要邀请码"}</p>{data.overview.guestAdmissionMode === "invite" && action("查看与轮换邀请码", "manageInvites", () => setDialog("invite"))}</section>
      <section><h2>共享层</h2><ul>{data.overview.layers.map(layer => <li key={layer.slot}>{layer.name} · {layer.active ? "启用" : "停用"}</li>)}</ul>{action("管理共享层配置", "configureLayers", () => undefined, `/choirs/${choirId}/shared-layers`)}</section>
      <section className="personal-settings-links"><Link className="settings-secondary-link" to={`/choirs/${choirId}/memberships`}>成员与权限</Link>{action("回收站", "trashFiles", () => setDialog("trash"))}</section>
      {locked && <section className="permission-lock-explanation" role="status"><h2>需要“{operationLabels[locked]}”权限</h2><p>可以联系：{data.members.memberships.filter(member => member.status === "active" && (member.isOwner || member.operations.operations.includes(locked))).map(member => member.displayName).join("、") || "云盘拥有者"}。</p><p>申请授权可联系：{data.members.memberships.filter(member => member.status === "active" && (member.isOwner || member.management.operations.includes(locked))).map(member => member.displayName).join("、") || "云盘拥有者"}。受托人只能在范围内为普通成员授权。</p><Link to={`/choirs/${choirId}/memberships`}>查看成员与权限</Link></section>}
      {dialog === "name" && can("editDriveInfo") && <DriveSettingsDialog choirId={choirId} field="name" onClose={() => setDialog(null)} onSaved={async () => refresh()} />}
      {dialog === "invite" && can("manageInvites") && <InviteCodeDialog choirId={choirId} choirName={data.overview.name} onClose={() => setDialog(null)} />}
      {dialog === "trash" && can("trashFiles") && <TrashDialog choirId={choirId} onClose={() => setDialog(null)} onRestored={refresh} />}
    </>}
  </main></div>;
}
