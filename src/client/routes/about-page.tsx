import { buildId, buildRunId } from "../../shared/build";
import { AppHeader } from "../components/app-header";
import { UpdateDetails } from "../components/reload-prompt";
export default function AboutPage() {
  return <div className="app-page"><AppHeader /><main className="page-shell compact-page"><h1>关于合谱</h1><p>合唱乐谱与排练笔记</p><p>{buildRunId ? `版本 #${buildRunId}` : "本地开发版"}</p><UpdateDetails /><details className="about-build"><summary>技术详情</summary><p>构建标识</p><code>{buildId}</code></details></main></div>;
}
