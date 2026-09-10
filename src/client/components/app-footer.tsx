import { Link } from "react-router-dom";

export function AppFooter() {
  return (
    <footer className="app-footer">
      <nav aria-label="产品信息">
        <Link to="/help">使用手册</Link>
        <Link to="/about">关于合谱</Link>
        <Link to="/privacy">隐私政策</Link>
      </nav>
    </footer>
  );
}
