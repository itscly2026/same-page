import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Menu, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import { Link, useNavigate } from "react-router-dom";
import "../settings/settings-ux.css";

export function AppHeader({ actions }: { actions?: ReactNode }) {
  const navigate = useNavigate();

  return (
    <header className="app-header">
      <Link className="brand-link" to="/" aria-label="Same Page 首页">
        <img src="/icon-192.png" alt="" width="44" height="44" />
        <span>Same Page</span>
      </Link>
      <nav className="app-header__actions">
        {actions}
        <MenuTrigger>
          <Button className="header-action header-help-button" aria-label="帮助与关于">
            <CircleHelp aria-hidden="true" size={20} />
          </Button>
          <Popover className="file-menu-popover" placement="bottom end">
            <Menu aria-label="帮助与关于">
              <MenuItem onAction={() => navigate("/diagnostics")}>故障诊断</MenuItem>
              <MenuItem onAction={() => navigate("/privacy")}>隐私政策</MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
      </nav>
    </header>
  );
}
