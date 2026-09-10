import { useLayoutEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { TaskHeader } from "../components/task-header";

const chapters = [
  { id: "start", title: "创建或加入云盘", paragraphs: [
    "合谱以云盘组织乐谱和排练笔记。使用邮箱或 Google 登录后，可以创建自己的云盘，或通过邀请加入已有云盘。每个云盘中的显示名可以分别设置。",
    "免费体验云盘每人最多拥有一个，支持 10 份乐谱、50 MB PDF 空间和 20 位成员（含拥有者）。拥有者可以通过邀请码邀请成员；邀请码请只交给需要访问的人。",
    "访客或公开体验访问可以阅读允许访问的内容，并在当前浏览器试写笔记。体验笔记保存在本机，不上传，登录后也不会自动转入个人笔记。",
  ] },
  { id: "read", title: "上传和阅读乐谱", paragraphs: [
    "进入云盘后，按文件名查找乐谱。有上传权限的成员可以上传 PDF；没有看到上传入口时，可以向云盘拥有者或有相应授权管理权限的成员申请权限。",
    "打开乐谱默认进入阅读模式，可以翻页、滚动和缩放。阅读器支持翻页与连续滚动，可按排练习惯选择。进入编辑模式后，只编辑当前页；完成编辑后再翻页。",
    "替换 PDF 会保留乐谱身份，但谱面变化可能影响笔记位置。确认替换前请检查新版谱面；旧版本保留 30 天供回滚。",
  ] },
  { id: "notes", title: "个人笔记与共享批注", paragraphs: [
    "“我的笔记”默认仅自己可见、仅自己可编辑。你可以新建多个个人层，并逐层向云盘成员只读分享；分享不会允许别人修改你的笔记。",
    "共享层供云盘内有访问权的人查看，只有获得对应层编辑权的成员才能修改。新云盘默认提供 Ensemble、Soprano、Alto、Tenor、Bass，可由有权限的成员调整。",
    "阅读时选择显示哪些笔记层；显示选择不会授予编辑权。编辑时选定一个有编辑权的层，只显示并修改该层，完成编辑后恢复阅读时的显示选择。",
  ] },
  { id: "members", title: "邀请成员与分配权限", paragraphs: [
    "在云盘管理的“成员与权限”中，可以按成员或按权限查看安排。需要协助时，查找对应事项中“可以操作”或“可以授权”的人。",
    "上传文件、修改文件、管理成员和编辑共享层等权限分别授予。拥有者可以指定受托权限管理者；受托人只能在授权范围内管理普通成员的权限。",
    "返回云盘列表不会退出成员身份。“退出云盘成员身份”会撤销该关系授予的云端访问与同步权限，请在操作前处理待同步笔记。",
  ] },
  { id: "offline", title: "离线使用与联网同步", paragraphs: [
    "仅打开过乐谱不代表已有离线副本。断网排练前，请确认当前设备上所需乐谱的离线副本已就绪；其他设备需要分别准备。",
    "笔记修改先保存在当前设备，联网且权限有效时提交到云端。打开乐谱、提交修改或主动点击“同步”会更新云端状态；持续阅读期间不会定时刷新。",
    "重新联网后，待提交草稿会恢复提交。若提示权限不足或冲突，请按提示处理；尚未同步的草稿只保存在当前设备，请勿清除站点数据。",
    "清理本机谱面文件用于释放当前设备空间，不会删除云端乐谱；PDF 导出与保存离线副本是两种不同操作。",
  ] },
  { id: "export", title: "导出和删除", paragraphs: [
    "导出 PDF 时，可以选择本次包含的笔记层，将谱面与有权查看的笔记合成为独立文件。导出选择不会改变平时显示的图层，也不会自动建立离线副本。",
    "乐谱移入回收站后可在 30 天内恢复，到期后清理。历史 PDF 和回收站中的文件仍占存储空间；拥有者可以提前彻底删除。",
    "彻底删除乐谱或云盘会终止相关内容的产品访问与恢复能力，关联笔记也随之删除。已下载到其他设备的文件无法即时远程收回。",
  ] },
  { id: "retention", title: "免费体验云盘的闲置清理", paragraphs: [
    "为合理利用存储资源，连续超过 30 天无成员联网访问的云盘可能被清理。清理前，我们会至少提前 14 天通过邮件通知云盘拥有者；通知期内任一成员重新联网访问云盘，即取消本次清理。",
    "超过 30 天不代表立即删除。清理通知邮件会说明如何保留云盘；请在通知期内联网进入该云盘。离线打开已有副本不计作联网访问。",
  ] },
  { id: "questions", title: "常见问题", paragraphs: [
    "找不到乐谱：先确认云盘是否正确，再按文件名搜索。断网时只能打开已有离线副本；联网后刷新目录，或请有上传权限的成员确认文件是否已上传。",
    "不能编辑笔记：先进入编辑模式，再确认选中的层。个人层只允许本人编辑，共享层需要对应编辑权；到“成员与权限”查找可以授权的人。",
    "笔记没有同步：检查网络和当前登录身份，再查看阅读器的同步状态。权限不足时联系可以授权的人，冲突时按提示处理，并保留当前设备上的草稿。",
  ] },
];

export default function HelpPage() {
  const { hash, key } = useLocation();
  useLayoutEffect(() => {
    const target = document.getElementById(hash.slice(1));
    if (target) { target.focus({ preventScroll: true }); target.scrollIntoView(); }
  }, [hash, key]);
  return <div className="privacy-page">
    <TaskHeader title="使用手册" backTo="/drives" />
    <main className="privacy-document" aria-label="使用手册">
      <header className="privacy-document__header">
        <p className="eyebrow">合谱 · Same Page</p>
        <p className="privacy-document__updated">最后更新于 <time dateTime="2026-09-10">2026-09-10</time></p>
        <p className="privacy-document__lead">从加入云盘到离线排练，了解乐谱、笔记和成员权限如何配合使用。</p>
      </header>
      <details className="manual-contents" id="contents" tabIndex={-1} open>
        <summary>导览目录</summary>
        <nav aria-label="手册目录"><ol>{chapters.map(chapter => <li key={chapter.id}><Link replace to={`#${chapter.id}`}>{chapter.title}</Link></li>)}</ol></nav>
      </details>
      {chapters.map(chapter => <section key={chapter.id} aria-labelledby={chapter.id}>
        <h2 id={chapter.id} tabIndex={-1}>{chapter.title}</h2>
        {chapter.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
        <Link replace className="manual-back" to="#contents">返回目录</Link>
      </section>)}
      <section aria-labelledby="diagnostics"><h2 id="diagnostics">仍然无法解决？</h2><p>可以查看故障记录，或主动发送诊断给合谱维护人员。</p><Link to="/diagnostics">故障诊断</Link></section>
    </main>
  </div>;
}
