import { Link } from "react-router-dom";
import { buildId, buildRunId } from "../../shared/build";
import { TaskHeader } from "../components/task-header";
import { UpdateDetails } from "../components/reload-prompt";
export default function AboutPage() {
  return <div className="app-page"><TaskHeader title="关于合谱" backTo="/drives" /><main className="page-shell compact-page"><p>合唱乐谱与排练笔记</p><p>{buildRunId ? `版本 #${buildRunId}` : "本地开发版"}</p><UpdateDetails /><p><Link to="/privacy">隐私政策</Link></p><details className="about-build"><summary>技术详情</summary><p>构建标识</p><code>{buildId}</code></details></main></div>;
}
