import { useLogout } from "../auth/logout";
import { Menu as MenuIcon, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button,  Form, Heading, Input,  MenuItem, MenuTrigger, Modal, ModalOverlay, Popover, TextField } from "react-aria-components";
import { Menu } from "../navigation/overlays";
import { Dialog } from "../navigation/overlays";
import { Link } from "react-router-dom";
import { choirMembershipsResponseSchema } from "../../shared/choirs";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { MembershipList } from "./membership-list";

export function DriveHeader({ choirId, choirName, userId, search, onSearch, onRefresh, management, onEditDisplayName, localOnly = false, avatarRevision = 0, resolvingIdentity = false }: {
  choirId: string; choirName: string; userId?: string; search: string;
  onSearch: (value: string) => void; onRefresh: () => void;
  resolvingIdentity?: boolean; localOnly?: boolean; avatarRevision?: number; onEditDisplayName?: () => void;
  management?: (close: () => void) => ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  return <>
    <header className="drive-header">
      <Button className="icon-button" aria-label="打开云盘菜单" onPress={() => setDrawerOpen(true)}><MenuIcon aria-hidden="true" size={23} /></Button>
      <Form className="library-search drive-search" role="search" onSubmit={event => { event.preventDefault(); onRefresh(); }}>
        <TextField value={search} onChange={onSearch} aria-label="搜索乐谱"><Input type="search" placeholder="搜索乐谱" /></TextField>
      </Form>
      {userId ? <DriveAvatar key={`${userId}:${choirId}:${avatarRevision}`} userId={userId} choirId={choirId} onEditDisplayName={onEditDisplayName} localOnly={localOnly} /> : resolvingIdentity ? <span className="drive-avatar" aria-label="正在恢复用户">我</span> : <Link className="drive-avatar" aria-label="登录或注册" to="/login">访</Link>}
    </header>
    <ModalOverlay className="drive-drawer-overlay" isOpen={drawerOpen} onOpenChange={setDrawerOpen} isDismissable>
      <Modal className="drive-drawer"><Dialog aria-label="云盘菜单">{({ close }) => <>
        <div className="dialog-heading"><Heading slot="title">{choirName}</Heading><Button className="icon-button" aria-label="关闭" onPress={close}><X size={21} aria-hidden="true" /></Button></div>
        <Button className="drive-drawer-switch" onPress={() => { close(); setPickerOpen(true); }}>切换云盘</Button>

        {management?.(close)}
        <nav aria-label="云盘导航"><Link to="/storage" onClick={close}>本机存储</Link><Link to="/diagnostics" onClick={close}>故障诊断</Link></nav>
      </>}</Dialog></Modal>
    </ModalOverlay>
    <DrivePicker choirId={choirId} userId={userId} localOnly={localOnly} isOpen={pickerOpen} onOpenChange={setPickerOpen} />
  </>;
}

export function DrivePicker({ choirId, userId, isOpen, onOpenChange, localOnly = false }: {
  choirId: string; userId?: string; localOnly?: boolean; isOpen: boolean; onOpenChange: (open: boolean) => void;
}) {
  return (
    <ModalOverlay className="modal-overlay" isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
      <Modal className="app-modal"><Dialog className="app-dialog drive-picker-dialog">{({ close }) => <>
        <div className="dialog-heading"><Heading slot="title">切换云盘</Heading><Button className="icon-button" aria-label="关闭" onPress={close}><X size={21} aria-hidden="true" /></Button></div>
        {userId ? <MembershipList localOnly={localOnly} userId={userId} currentChoirId={choirId} onSelect={close} /> : <p><Link to="/login">登录后查看已加入的云盘</Link></p>}
        <Link className="drive-picker-join secondary-button" to="/?join=1" onClick={close}>{userId ? "加入新云盘" : "使用邀请码进入云盘"}</Link>
      </>}</Dialog></Modal>
    </ModalOverlay>
  );
}

function DriveAvatar({ userId, choirId, onEditDisplayName, localOnly }: { userId: string; choirId: string; onEditDisplayName?: () => void; localOnly: boolean }) {
  const logout = useLogout();
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
  return <><MenuTrigger>
    <Button className="drive-avatar" aria-label="用户菜单">{initial}</Button>
    <Popover className="file-menu-popover account-menu-popover"><Menu aria-label="用户菜单">
      <MenuItem isDisabled={!onEditDisplayName || localOnly} onAction={onEditDisplayName}>我在此云盘的显示名{localOnly ? "（需联网）" : ""}</MenuItem>
      <MenuItem href={`/choirs/${choirId}/preferences`}>阅读偏好</MenuItem><MenuItem href="/user">个人设置</MenuItem><MenuItem onAction={() => void logout.request()}>退出登录</MenuItem>
    </Menu></Popover>
  </MenuTrigger>{logout.dialog}</>;
}
