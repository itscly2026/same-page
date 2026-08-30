import { version as pdfJsVersion } from "pdfjs-dist";
import { Link } from "react-router-dom";

export default function ReaderPage() {
  return (
    <main className="page-shell reader-placeholder">
      <p className="eyebrow">Reader route · lazy loaded</p>
      <h1>阅读器接入点已准备</h1>
      <p>
        PDF.js {pdfJsVersion} 只在进入此路由时加载。正式阅读器将在 Issue #7
        中实现。
      </p>
      <Link className="primary-link" to="/">
        返回工程状态
      </Link>
    </main>
  );
}
