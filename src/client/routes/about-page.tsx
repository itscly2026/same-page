import { buildId } from "../../shared/build";
import { AppHeader } from "../components/app-header";
import { UpdateDetails } from "../components/reload-prompt";
export default function AboutPage() {
  return <div className="app-page"><AppHeader /><main className="page-shell compact-page"><h1>关于合谱</h1><p>合唱乐谱与排练批注</p><p>当前运行构建：<code>{buildId}</code></p><UpdateDetails /></main></div>;
}
