import { DriveLibrary } from "../score-library/drive-library";
import { driveCacheOwnerKey } from "../score-library/drive-library-cache";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "react-aria-components";
import { Link, useParams } from "react-router-dom";
import { LockKeyhole } from "lucide-react";
import { authClient } from "../auth/auth-client";
import { TaskHeader } from "../components/task-header";
import { driveManagementSchema } from "../../shared/drive-management";
import { managedMembershipsSchema } from "../../shared/lifecycle";
import { operationLabels, type Operation } from "../../shared/drive-permissions";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { SettingsRequestError, settingsError } from "../settings/settings-request";
import { DriveSettingsDialog } from "../score-library/drive-settings-dialog";
import { InviteCodeDialog } from "../score-library/invite-code-dialog";
import { TrashContents } from "../score-library/trash-contents";

type Overview = ReturnType<typeof driveManagementSchema.parse>;
type Members = ReturnType<typeof managedMembershipsSchema.parse>;
export default function DriveManagementPage({ section }: { section: "info" | "admission" | "trash" }) {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <DriveManagement key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} section={section} />;
}
function DriveManagement({ choirId, section }: { choirId: string; section: string }) {
  const [data, setData] = useState<{ overview: Overview; members: Members } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<"name" | "invite" | null>(null);
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
    void load().catch(error => { if (!controller.signal.aborted) { setData(null); setError(settingsError(error, "云盘设置加载失败，请联网后重试。")); } });
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
  return <div className="app-page"><TaskHeader title={{ info: "基本信息", admission: "加入方式", trash: "回收站" }[section] ?? "云盘管理"} backTo={`/choirs/${choirId}`} /><main className="page-shell settings-page settings-ux">
    <header className="settings-heading"><p>{data?.overview.name ?? "查看配置与权限分工"}</p></header>
    {!data && <p role={error ? "alert" : "status"}>{error ?? "正在读取云盘设置…"}</p>}
    {error && <Button className="secondary-button" onPress={refresh}>重新读取</Button>}
    {data && <>
      <div className="management-list">
        {section === "info" && row("云盘名称", data.overview.name, "修改云盘名称", "editDriveInfo", () => setDialog("name"))}
        {section === "admission" && (data.overview.guestAdmissionMode === "invite" ? row("访客进入方式", "需要邀请码", "查看与轮换邀请码", "manageInvites", () => setDialog("invite")) : <section className="management-row"><h2>访客进入方式</h2><p>开放进入</p></section>)}
        {section === "trash" && (can("trashFiles") ? <TrashContents choirId={choirId} onRestored={() => {}} /> : row("回收站", "恢复文件需要删除与恢复文件权限。", "查看权限说明", "trashFiles", () => {}))}
      </div>
      {dialog === "name" && can("editDriveInfo") && <NameSettings choirId={choirId} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === "invite" && can("manageInvites") && <InviteCodeDialog choirId={choirId} choirName={data.overview.name} onClose={() => setDialog(null)} />}
    </>}
  </main></div>;
}

function NameSettings({ choirId, onClose, onSaved }: { choirId: string; onClose: () => void; onSaved: () => void }) {
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const library = useMemo(() => new DriveLibrary(driveCacheOwnerKey(userId ?? null, choirId), choirId), [userId, choirId]);
  const snapshot = useSyncExternalStore(library.subscribe, library.getSnapshot);
  useEffect(() => {
    library.setAuthenticated(Boolean(userId));
    library.start();
    return () => library.stop();
  }, [library, userId]);
  if (snapshot.access.kind !== "opened") return <div><p role="status">正在准备云盘信息，请稍候；若无法加载，请重试。</p><Button onPress={() => void library.refresh()}>重试</Button><Button onPress={onClose}>取消</Button></div>;
  return <DriveSettingsDialog choirId={choirId} field="name" onClose={onClose} onSaved={async name => { await library.confirmName(name); onSaved(); }} />;
}
