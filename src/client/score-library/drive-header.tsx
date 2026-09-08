import { Menu as MenuIcon, Settings2, ArrowLeft } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button,  Form, Heading, Input,  MenuItem, MenuTrigger, Modal, ModalOverlay, Popover, TextField } from "react-aria-components";
import { Menu } from "../navigation/overlays";
import { Dialog } from "../navigation/overlays";
import { Link } from "react-router-dom";

export function DriveHeader({ choirId, choirName, userId, search, onSearch, onRefresh, management, onEditDisplayName, localOnly = false, resolvingIdentity = false }: {
  choirId: string; choirName: string; userId?: string; search: string;
  onSearch: (value: string) => void; onRefresh: () => void;
  resolvingIdentity?: boolean; localOnly?: boolean; onEditDisplayName?: () => void;
  management?: (close: () => void) => ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  return <>
    <header className="drive-header">
      <Button className="icon-button" aria-label="打开云盘菜单" onPress={() => setDrawerOpen(true)}><MenuIcon aria-hidden="true" size={23} /></Button>
      <Form className="library-search drive-search" role="search" onSubmit={event => { event.preventDefault(); onRefresh(); }}>
        <TextField value={search} onChange={onSearch} aria-label={`搜索「${choirName}」中的乐谱`}><Input type="search" placeholder={`搜索「${choirName}」中的乐谱`} /></TextField>
      </Form>
      {userId ? <DriveSettingsMenu choirId={choirId} choirName={choirName} onEditDisplayName={onEditDisplayName} localOnly={localOnly} /> : resolvingIdentity ? <span className="drive-avatar" aria-label="正在恢复用户">我</span> : <Link className="drive-avatar" aria-label="登录或注册" to="/login">访</Link>}
    </header>
    <ModalOverlay className="drive-drawer-overlay" isOpen={drawerOpen} onOpenChange={setDrawerOpen} isDismissable>
      <Modal className="drive-drawer"><Dialog aria-label="云盘菜单">{({ close }) => <>
        <Link className="drive-drawer-switch" to="/drives" onClick={close}><ArrowLeft size={18} aria-hidden="true" />云盘列表</Link>
        <div className="dialog-heading"><Heading slot="title">{choirName}</Heading></div>

        {management?.(close)}
        <footer className="drive-drawer-footer"><Link to="/help" onClick={close}>帮助</Link><Link to="/about" onClick={close}>关于合谱</Link></footer>
      </>}</Dialog></Modal>
    </ModalOverlay>
  </>;
}

function DriveSettingsMenu({ choirId, choirName, onEditDisplayName, localOnly }: { choirId: string; choirName: string; onEditDisplayName?: () => void; localOnly: boolean }) {
  return <MenuTrigger>
    <Button className="icon-button" aria-label="此云盘设置"><Settings2 aria-hidden="true" size={22} /></Button>
    <Popover className="file-menu-popover account-menu-popover"><Menu aria-label="此云盘设置">
      <MenuItem isDisabled>{choirName} · 我的设置</MenuItem>
      <MenuItem isDisabled={!onEditDisplayName || localOnly} onAction={onEditDisplayName}>我在此云盘的显示名{localOnly ? "（需联网）" : ""}</MenuItem>
      <MenuItem href={`/choirs/${choirId}/preferences`}>阅读偏好</MenuItem><MenuItem href={`/choirs/${choirId}/storage`}>本机存储</MenuItem><MenuItem href={`/choirs/${choirId}/me`}>云盘个人设置</MenuItem>
    </Menu></Popover>
  </MenuTrigger>;
}
