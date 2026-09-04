import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function AppHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="app-header">
      <Link className="brand-link" to="/" aria-label="Same Page 首页">
        <img src="/icon-192.png" alt="" width="44" height="44" />
        <span>Same Page</span>
      </Link>
      <nav className="app-header__actions">{actions}<Link to="/diagnostics">故障诊断</Link></nav>
    </header>
  );
}
