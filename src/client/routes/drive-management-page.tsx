import { NAVIGATION_FRESH_MS } from "../settings/navigation-events";
import { notifyReaderIdentityChange } from "../reader/reader-cache-events";
import { rememberDriveAccessRevoked } from "../score-library/local-drive-directory";
import { authenticatedLocalOwnerKey, captureLocalWorkspaceSession, createLocalWorkspace } from "../platform/local-workspace";
import { PurgeDialog } from "../drives/purge-dialog";
import { DriveUsage } from "../drives/drive-usage";
import { useReadResource } from "../settings/use-read-resource";
import { useDriveLibraryResource } from "../score-library/use-drive-library";
import { driveCacheOwnerKey, invalidateDriveLibrary } from "../score-library/drive-library-cache";
import { useState } from "react";
import { Button } from "react-aria-components";
import { Link, useNavigate, useParams } from "react-router-dom";
import { LockKeyhole } from "lucide-react";
import { authClient } from "../auth/auth-client";
import { TaskHeader } from "../components/task-header";
import { driveManagementSchema } from "../../shared/drive-management";
import { managedMembershipsSchema } from "../../shared/lifecycle";
import { operationLabels, type Operation } from "../../shared/drive-permissions";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { SettingsRequestError, settingsError } from "../settings/settings-request";
import { DriveSettingsDialog } from "../score-library/drive-settings-dialog";
import { InviteSharing } from "../score-library/invite-sharing";
import { TrashContents } from "../score-library/trash-contents";

type Overview = ReturnType<typeof driveManagementSchema.parse>;
type Members = ReturnType<typeof managedMembershipsSchema.parse>;
export default function DriveManagementPage({ section }: { section: "info" | "admission" | "trash" }) {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <DriveManagement key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} userId={session.data?.user.id ?? "guest"} section={section} />;
}
function DriveManagement({ choirId, section, userId }: { choirId: string; section: string; userId: string }) {
  const navigate = useNavigate();
  const [purge, setPurge] = useState(false);
  const [dialog, setDialog] = useState<"name" | null>(null);
  const [locked, setLocked] = useState<Operation | null>(null);
  const resource = useReadResource<Overview>({ owner: userId, driveId: choirId, kind: "management" }, async signal => {
    const overviewResponse = await diagnosticFetch(`/api/choirs/${choirId}/management`, { signal });
    if (!overviewResponse.ok) throw new SettingsRequestError(overviewResponse.status);
    return parseDiagnosticResponse(overviewResponse, driveManagementSchema);
  }, undefined, NAVIGATION_FRESH_MS);
  const data = resource.data;
  const error = resource.error ? settingsError(resource.error, "云盘设置更新失败，已有内容已保留。") : null;
  const refresh = () => { setDialog(null); setLocked(null); void resource.refresh().catch(() => undefined); };
  const can = (operation: Operation) => data?.capabilities.operations.operations.includes(operation);
  function row(title: string, value: string, label: string, operation: Operation, destination: (() => void) | string) {
    const allowed = can(operation);
    return <section className="management-row">
      <div className="management-row-main"><div><h2>{title}</h2><p>{value}</p></div>{allowed && typeof destination === "string" ? <Link className="secondary-button" to={destination}>{label}</Link> : <Button className="secondary-button" isDisabled={!resource.canMutate} aria-label={`${label}${allowed ? "" : "（权限说明）"}`} onPress={() => { if (allowed && resource.canMutate && typeof destination === "function") destination(); else setLocked(current => current === operation ? null : operation); }}>{!allowed && <LockKeyhole size={15} aria-hidden="true" />}{label}</Button>}</div>
      {locked === operation && <PermissionContacts userId={userId} choirId={choirId} operation={operation} isMember={Boolean(data?.isMember)} />}
    </section>;
  }
  return <div className="app-page"><TaskHeader title={{ info: "基本信息", admission: "加入方式", trash: "回收站" }[section] ?? "云盘管理"} backTo={`/choirs/${choirId}`} /><main className="page-shell settings-page settings-ux">
    <header className="settings-heading"><p>{data?.name ?? "查看配置与权限分工"}</p></header>
    {!data && <p role={error ? "alert" : "status"}>{error ?? "正在读取云盘设置…"}</p>}
    {error && data && <p role="alert">{error}</p>}{error && <Button className="secondary-button" onPress={refresh}>重新读取</Button>}
    {data && <>
      {!data.isMember && <p className="permission-lock-explanation">你正在只读浏览此云盘。可了解功能与公开配置；修改设置需要成为成员并获得相应授权。</p>}
      <div className="management-list">
        {section === "info" && row("云盘名称", data.name, "修改云盘名称", "editDriveInfo", () => setDialog("name"))}
        {section === "admission" && (data.guestAdmissionMode === "invite" ? (resource.canMutate && can("manageInvites") ? <InviteSharing choirId={choirId} choirName={data.name} /> : row("访客进入方式", "需要邀请码", "查看权限说明", "manageInvites", () => {})) : <section className="management-row"><h2>访客进入方式</h2><p>开放进入</p></section>)}
        {section === "trash" && (resource.canMutate && can("trashFiles") ? <TrashContents userId={userId} canPurge={data.capabilities.isOwner} choirId={choirId} onRestored={() => { invalidateDriveLibrary(driveCacheOwnerKey(userId, choirId), choirId); }} /> : row("回收站", "删除的乐谱在此保留 30 天。有删除与恢复文件权限的成员可查看并恢复。", "查看权限说明", "trashFiles", () => {}))}
        {section === "info" && data.isMember && <DriveUsage choirId={choirId} userId={userId} />}
        {section === "info" && data.capabilities.isOwner && <section className="management-row"><h2>删除云盘</h2><p>所有成员将失去此云盘及其乐谱和笔记的访问权限。</p><Button className="primary-button destructive-button" isDisabled={!resource.canMutate} onPress={() => setPurge(true)}>彻底删除云盘</Button></section>}
      </div>
      {purge && resource.canMutate && data.capabilities.isOwner && <PurgeDialog userId={userId} path={`/api/choirs/${choirId}/purge`} title="彻底删除云盘" driveName={data.name} description="云盘内的全部乐谱和所有成员的笔记都会被删除。" onClose={() => setPurge(false)} onComplete={async isCurrent => {
        const workspace = await captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey(userId), choirId, ""));
        if (!isCurrent()) return;
        await rememberDriveAccessRevoked(workspace, new AbortController().signal);
        if (!isCurrent()) return;
        invalidateDriveLibrary(driveCacheOwnerKey(userId, choirId), choirId);
        notifyReaderIdentityChange();
        navigate("/drives", { replace: true });
      }} />}
      {dialog === "name" && resource.canMutate && can("editDriveInfo") && <NameSettings choirId={choirId} onClose={() => setDialog(null)} onSaved={refresh} />}
    </>}
  </main></div>;
}

function NameSettings({ choirId, onClose, onSaved }: { choirId: string; onClose: () => void; onSaved: () => void }) {
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const { library, snapshot } = useDriveLibraryResource(driveCacheOwnerKey(userId ?? null, choirId), choirId, Boolean(userId), true, session.data?.session?.id ?? null);
  if (snapshot.access.kind !== "opened") return <div><p role="status">正在准备云盘信息，请稍候；若无法加载，请重试。</p><Button onPress={() => void library.refresh()}>重试</Button><Button onPress={onClose}>取消</Button></div>;
  return <DriveSettingsDialog choirId={choirId} userId={userId!} field="name" onClose={onClose} onSaved={async name => { await library.confirmName(name); onSaved(); }} />;
}

function PermissionContacts({ userId, choirId, operation, isMember }: { userId: string; choirId: string; operation: Operation; isMember: boolean }) {
  return <div className="permission-lock-explanation" role="status"><p>需要“{operationLabels[operation]}”权限。</p>{isMember && <MemberContacts userId={userId} choirId={choirId} operation={operation} />}<Link to={`/choirs/${choirId}/memberships`}>查看权限分工</Link></div>;
}
function MemberContacts({ userId, choirId, operation }: { userId: string; choirId: string; operation: Operation }) {
  const resource = useReadResource<Members>({ owner: userId, driveId: choirId, kind: "permission-contacts" }, async signal => {
    const response = await diagnosticFetch(`/api/choirs/${choirId}/memberships`, { signal });
    if (!response.ok) throw new SettingsRequestError(response.status);
    return parseDiagnosticResponse(response, managedMembershipsSchema);
  });
  const contacts = (scope: "operations" | "management") => resource.data?.memberships.filter(member => member.status === "active" && (member.isOwner || member[scope].operations.includes(operation))).map(member => member.displayName).join("、") || "云盘拥有者";
  return <><p>处理此项可联系 {contacts("operations")}。</p>{contacts("operations") !== contacts("management") && <p>申请授权可联系 {contacts("management")}。</p>}</>;
}
