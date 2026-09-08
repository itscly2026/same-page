import { useReturnViewport } from "../navigation/use-return-viewport";
import { Menu as MenuIcon, X, ArrowLeft } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Button,  Form, Heading, Input,   Modal, ModalOverlay,  TextField } from "react-aria-components";
import { useReturnState } from "../navigation/navigation-context";
import { PersonalMenu } from "../components/personal-menu";
import { Dialog } from "../navigation/overlays";
import { Link } from "react-router-dom";

export function DriveHeader({ choirId, choirName, userId, search, onSearch, onRefresh, management, onEditDisplayName, localOnly = false, resolvingIdentity = false, loading = false }: {
  choirId: string; choirName: string; userId?: string; search: string;
  onSearch: (value: string) => void; onRefresh: () => void;
  loading?: boolean; resolvingIdentity?: boolean; localOnly?: boolean; onEditDisplayName?: () => void;
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
      <div className="drive-header__identity"><strong title={choirName}>{choirName}</strong><Form className="library-search drive-search" role="search" onSubmit={event => { event.preventDefault(); onRefresh(); }}>
        <TextField value={search} onChange={onSearch} aria-label={`搜索「${choirName}」中的乐谱`}><Input type="search" placeholder="搜索乐谱" /></TextField>
      </Form></div>
      {userId ? <PersonalMenu /> : resolvingIdentity ? <span className="drive-avatar" aria-label="正在恢复用户">我</span> : <Link className="drive-avatar" aria-label="登录或注册" to="/login">访</Link>}
    </header>
    <ModalOverlay className="drive-drawer-overlay" isOpen={drawerOpen && !loading} onOpenChange={setDrawerOpen} isDismissable>
      <Modal className="drive-drawer"><Dialog preserveOnNavigate aria-label="云盘菜单">{({ close }) => <DrawerBody>
        <Link className="drive-drawer-switch" to="/drives" ><ArrowLeft size={18} aria-hidden="true" />云盘列表</Link>
        <div className="dialog-heading"><Heading slot="title">{choirName}</Heading><Button className="icon-button" aria-label="关闭云盘菜单" onPress={close}><X aria-hidden="true" size={22} /></Button></div>

        {userId && <section className="drive-drawer-management"><h3>我在此云盘</h3>
          {onEditDisplayName && <Button isDisabled={localOnly} onPress={() => { close(); onEditDisplayName(); }}>云盘内显示名</Button>}
          <Link to={`/choirs/${choirId}/preferences`}>阅读偏好</Link>
          <Link to={`/choirs/${choirId}/storage`}>本机存储</Link>
          {onEditDisplayName && <Link to={`/choirs/${choirId}/me`}>退出云盘成员身份</Link>}
        </section>}
        {management?.(close)}
        <footer className="drive-drawer-footer"><Link to="/help" >帮助</Link></footer>
      </DrawerBody>}</Dialog></Modal>
    </ModalOverlay>
  </>;
}

function DrawerBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useReturnViewport(ref, "drawer", true);
  return <div ref={ref} className="drive-drawer-content">{children}</div>;
}
