import { InstallButton } from "../install/install-entry";
import { RefreshCw } from "lucide-react";
import { useReturnViewport } from "../navigation/use-return-viewport";
import { Menu as MenuIcon, List, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Button,  Form, Heading, Input,   Modal, ModalOverlay,  TextField } from "react-aria-components";
import { useReturnState } from "../navigation/navigation-context";
import { DrivePersonalMenu } from "./drive-personal-menu";
import { Dialog } from "../navigation/overlays";
import { Link } from "react-router-dom";

export function DriveHeader({ choirId, choirName, userId, search, onSearch, onRefresh, management, onEditDisplayName, displayName, localOnly = false, resolvingIdentity = false, refreshing = false, loading = false }: {
  choirId: string; choirName: string; displayName?: string; userId?: string; search: string;
  onSearch: (value: string) => void; onRefresh: () => void;
  refreshing?: boolean; loading?: boolean; resolvingIdentity?: boolean; localOnly?: boolean; onEditDisplayName?: () => void;
  management?: (close: () => void) => ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useReturnState(`drawer:${userId ?? "guest"}`, false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(drawerOpen);
  useEffect(() => {
    const closed = wasOpen.current && !drawerOpen; wasOpen.current = drawerOpen;
    if (closed) { const frame = requestAnimationFrame(() => trigger.current?.focus()); return () => cancelAnimationFrame(frame); }
  }, [drawerOpen]);
  return <>
    <header className="drive-header">
      <Button ref={trigger} className="icon-button" aria-label="打开云盘菜单" onPress={() => setDrawerOpen(true)}><MenuIcon aria-hidden="true" size={23} /></Button>
      <Form className="library-search drive-search" role="search" onSubmit={event => { event.preventDefault(); }}>
        <TextField value={search} onChange={onSearch} aria-label={`搜索「${choirName}」中的乐谱`}><Input type="search" placeholder="搜索乐谱" /></TextField>
      </Form>
      <Button className="icon-button" aria-label="刷新乐谱列表" isPending={refreshing} onPress={onRefresh}><RefreshCw aria-hidden="true" size={19} /></Button>
      {userId ? <DrivePersonalMenu key={`${userId}:${choirId}:${displayName ?? ""}`} choirId={choirId} userId={userId} displayName={displayName} localOnly={localOnly} onEditDisplayName={onEditDisplayName} /> : resolvingIdentity ? <span className="drive-avatar" aria-label="正在恢复用户">我</span> : <Link className="drive-avatar" aria-label="登录或注册" to="/login">访</Link>}
    </header>
    <ModalOverlay className="drive-drawer-overlay" isOpen={drawerOpen && !loading} onOpenChange={setDrawerOpen} isDismissable>
      <Modal className="drive-drawer"><Dialog preserveOnNavigate aria-label="云盘菜单">{({ close }) => <DrawerBody>
        <div className="dialog-heading"><Heading slot="title">{choirName}</Heading><Button className="icon-button" aria-label="关闭云盘菜单" onPress={close}><X size={22} aria-hidden="true" /></Button></div>
        {management?.(close)}
        <footer className="drive-drawer-footer"><InstallButton /><Link className="drive-drawer-switch" to="/drives"><List size={18} aria-hidden="true" />云盘列表</Link></footer>
      </DrawerBody>}</Dialog></Modal>
    </ModalOverlay>
  </>;
}

function DrawerBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useReturnViewport(ref, "drawer", true);
  return <div ref={ref} className="drive-drawer-content">{children}</div>;
}
