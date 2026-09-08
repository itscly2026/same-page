import { AppMenu } from "./app-menu";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import "../settings/settings-ux.css";

export function AppHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="app-header">
      <Link className="brand-link" to="/" state={{ home: true }} aria-label="合谱 Same Page 首页">
        <img src="/icon-192.png" alt="" width="44" height="44" />
        <span className="brand-name-zh" lang="zh-CN">合谱</span>
        <span className="brand-name-en" lang="en">Same Page</span>
      </Link>
      <nav className="app-header__actions">
        {actions}<AppMenu />

      </nav>
    </header>
  );
}
