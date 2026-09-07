import { Menu as MenuIcon, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button,  Form, Heading, Input,  MenuItem, MenuTrigger, Modal, ModalOverlay, Popover, TextField } from "react-aria-components";
import { Menu } from "../navigation/overlays";
import { Dialog } from "../navigation/overlays";
import { Link } from "react-router-dom";
import { choirMembershipsResponseSchema } from "../../shared/choirs";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";

export function DriveHeader({ choirId, choirName, userId, search, onSearch, onRefresh, management, onEditDisplayName, localOnly = false, avatarRevision = 0, resolvingIdentity = false }: {
  choirId: string; choirName: string; userId?: string; search: string;
  onSearch: (value: string) => void; onRefresh: () => void;
  resolvingIdentity?: boolean; localOnly?: boolean; avatarRevision?: number; onEditDisplayName?: () => void;
  management?: (close: () => void) => ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  return <>
    <header className="drive-header">
      <Button className="icon-button" aria-label="打开云盘菜单" onPress={() => setDrawerOpen(true)}><MenuIcon aria-hidden="true" size={23} /></Button>
      <Form className="library-search drive-search" role="search" onSubmit={event => { event.preventDefault(); onRefresh(); }}>
        <TextField value={search} onChange={onSearch} aria-label={`搜索「${choirName}」中的乐谱`}><Input type="search" placeholder={`搜索「${choirName}」中的乐谱`} /></TextField>
      </Form>
      {userId ? <DriveAvatar key={`${userId}:${choirId}:${avatarRevision}`} userId={userId} choirId={choirId} onEditDisplayName={onEditDisplayName} localOnly={localOnly} /> : resolvingIdentity ? <span className="drive-avatar" aria-label="正在恢复用户">我</span> : <Link className="drive-avatar" aria-label="登录或注册" to="/login">访</Link>}
    </header>
    <ModalOverlay className="drive-drawer-overlay" isOpen={drawerOpen} onOpenChange={setDrawerOpen} isDismissable>
      <Modal className="drive-drawer"><Dialog aria-label="云盘菜单">{({ close }) => <>
        <div className="dialog-heading"><Heading slot="title">{choirName}</Heading><Button className="icon-button" aria-label="关闭" onPress={close}><X size={21} aria-hidden="true" /></Button></div>
        <Link className="drive-drawer-switch" to="/drives" onClick={close}>返回所有云盘</Link>

        {management?.(close)}
      </>}</Dialog></Modal>
    </ModalOverlay>
  </>;
}

function DriveAvatar({ userId, choirId, onEditDisplayName, localOnly }: { userId: string; choirId: string; onEditDisplayName?: () => void; localOnly: boolean }) {
  const [displayName, setDisplayName] = useState("");
  useEffect(() => {
    if (localOnly) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await diagnosticFetch("/api/choirs", { signal: controller.signal });
        if (!response.ok) return;
        const { memberships } = await parseDiagnosticResponse(response, choirMembershipsResponseSchema);
        if (!controller.signal.aborted) setDisplayName(memberships.find(entry => entry.choir.id === choirId)?.displayName.trim() ?? "");
      } catch { /* The account menu remains usable when membership names are unavailable. */ }
    })();
    return () => controller.abort();
  }, [userId, choirId, localOnly]);
  const initial = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(displayName))[0]?.segment.toLocaleUpperCase() ?? "我";
  return <MenuTrigger>
    <Button className="drive-avatar" aria-label="用户菜单">{initial}</Button>
    <Popover className="file-menu-popover account-menu-popover"><Menu aria-label="用户菜单">
      <MenuItem isDisabled={!onEditDisplayName || localOnly} onAction={onEditDisplayName}>我在此云盘的显示名{localOnly ? "（需联网）" : ""}</MenuItem>
      <MenuItem href={`/choirs/${choirId}/preferences`}>阅读偏好</MenuItem><MenuItem href={`/choirs/${choirId}/storage`}>本机存储</MenuItem><MenuItem href={`/choirs/${choirId}/me`}>退出此云盘</MenuItem>
    </Menu></Popover>
  </MenuTrigger>;
}
