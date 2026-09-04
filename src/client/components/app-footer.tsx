import { Link } from "react-router-dom";

export function AppFooter() {
  return (
    <footer className="app-footer">
      <nav aria-label="帮助与关于">
        <Link to="/privacy">隐私政策</Link>
        <Link to="/diagnostics">故障诊断</Link>
      </nav>
    </footer>
  );
}
