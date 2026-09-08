import { Link } from "react-router-dom";
import { AppHeader } from "../components/app-header";
export default function HelpPage() {
  return <div className="app-page"><AppHeader /><main className="page-shell compact-page"><h1>帮助</h1><p className="settings-copy">排练中遇到问题，可以先从这里找答案。</p><div className="help-topics"><details><summary>找不到乐谱</summary><p>先确认云盘是否正确，再按文件名搜索。断网时只能打开已有离线副本；联网后刷新云盘目录。仍找不到时，可请有上传文件权限的成员确认乐谱是否已上传。</p></details><details><summary>不能编辑批注</summary><p>打开乐谱后先进入编辑模式。“我的笔记”仅本人可编辑；共享层需要对应层的编辑权。到云盘管理的“成员与权限”，按该层查找可以授权的人。</p></details><details><summary>笔记还没有同步</summary><p>保持网络连接，确认仍以原用户登录。先查看阅读器的同步状态；如果显示权限不足，请联系云盘负责人。未同步草稿会保留在当前设备上，请勿清除站点数据。</p></details><details><summary>联系云盘负责人</summary><p>在“云盘管理 → 成员与权限 → 按权限”中选择要处理的事情。“可以操作”的人可帮忙处理，“可以授权”的人可调整普通成员的对应权限。</p></details></div><section className="help-diagnostics"><h2>仍然无法解决？</h2><p>查看故障记录，或将诊断发送给合谱维护人员。</p><Link className="secondary-link" to="/diagnostics">故障诊断</Link></section></main></div>;
}
