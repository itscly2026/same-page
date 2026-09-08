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
  const contacts = (operation: Operation, scope: "operations" | "management" = "operations") => data?.members.memberships.filter(member => member.status === "active" && (member.isOwner || member[scope].operations.includes(operation))).map(member => member.displayName).join("、") || "云盘拥有者";
  function row(title: string, value: string, label: string, operation: Operation, destination: (() => void) | string) {
    const allowed = can(operation);
    return <section className="management-row">
      <div className="management-row-main"><div><h2>{title}</h2><p>{value}</p></div>{allowed && typeof destination === "string" ? <Link className="secondary-button" to={destination}>{label}</Link> : <Button className="secondary-button" aria-label={`${label}${allowed ? "" : "（权限说明）"}`} onPress={() => { if (allowed && typeof destination === "function") destination(); else setLocked(current => current === operation ? null : operation); }}>{!allowed && <LockKeyhole size={15} aria-hidden="true" />}{label}</Button>}</div>
      {locked === operation && <div className="permission-lock-explanation" role="status"><p>需要“{operationLabels[operation]}”权限。</p><p>处理此项可联系 {contacts(operation)}。</p>{contacts(operation) !== contacts(operation, "management") && <p>申请授权可联系 {contacts(operation, "management")}。</p>}<Link to={`/choirs/${choirId}/memberships`}>查看权限分工</Link></div>}
    </section>;
  }
  return <div className="app-page"><AppHeader actions={<BackButton className="header-action" to={`/choirs/${choirId}`}>返回</BackButton>} /><main className="page-shell settings-page settings-ux">
    <header className="settings-heading"><h1>云盘管理</h1><p>{data?.overview.name ?? "查看配置与权限分工"}</p></header>
    {!data && <p role={error ? "alert" : "status"}>{error ?? "正在读取管理概览…"}</p>}
    {error && <Button className="secondary-button" onPress={refresh}>重新读取</Button>}
    {data && <>
      <div className="management-list">
        {row("云盘名称", data.overview.name, "修改云盘名称", "editDriveInfo", () => setDialog("name"))}
        {data.overview.guestAdmissionMode === "invite" ? row("访客进入方式", "需要邀请码", "查看与轮换邀请码", "manageInvites", () => setDialog("invite")) : <section className="management-row"><h2>访客进入方式</h2><p>开放进入</p></section>}
        {row("共享层", data.overview.layers.map(layer => `${layer.name}${layer.active ? "" : "（停用）"}`).join(" · ") || "尚未设置", "管理共享层配置", "configureLayers", `/choirs/${choirId}/shared-layers`)}
        <Link className="management-nav" aria-label="成员与权限" aria-describedby="membership-help" to={`/choirs/${choirId}/memberships`}><span><strong>成员与权限</strong><small id="membership-help">找负责人、查看或调整权限</small></span><span aria-hidden="true">›</span></Link>
        {row("回收站", "删除的乐谱保留三十天", "打开回收站", "trashFiles", () => setDialog("trash"))}
      </div>
      {dialog === "name" && can("editDriveInfo") && <DriveSettingsDialog choirId={choirId} field="name" onClose={() => setDialog(null)} onSaved={async () => refresh()} />}
      {dialog === "invite" && can("manageInvites") && <InviteCodeDialog choirId={choirId} choirName={data.overview.name} onClose={() => setDialog(null)} />}
      {dialog === "trash" && can("trashFiles") && <TrashDialog choirId={choirId} onClose={() => setDialog(null)} onRestored={refresh} />}
    </>}
  </main></div>;
}
