import { Link } from "react-router-dom";

export function AppFooter() {
  return (
    <footer className="app-footer">
      <nav aria-label="帮助与关于">
        <Link to="/help">使用手册</Link>
        <Link to="/about">关于合谱</Link>
      </nav>
    </footer>
  );
}
