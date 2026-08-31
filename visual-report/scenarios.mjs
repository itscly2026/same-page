export const visualReportScenarios = [
  {
    id: "home-guest",
    title: "首页 · 匿名访问",
    description: "未登录用户看到的产品入口。",
    device: "portrait",
    identity: "guest",
    route: "/",
    ready: { type: "role", role: "heading", name: "Every voice, on the same page." },
    actions: [],
  },
  {
    id: "home-entry-dialog",
    title: "首页 · 进入合唱团",
    description: "匿名用户使用邀请码进入合唱团的弹窗。",
    device: "portrait",
    identity: "guest",
    route: "/",
    ready: { type: "role", role: "dialog", name: "进入合唱团" },
    actions: [
      { type: "clickRole", role: "button", name: "进入合唱团" },
    ],
  },
  {
    id: "auth-sign-in",
    title: "身份 · 密码登录",
    description: "没有访客来源时的日常登录入口。",
    device: "portrait",
    identity: "guest",
    route: "/login",
    ready: { type: "text", text: "使用邮箱和密码登录；日常登录不发送验证码。" },
    actions: [],
  },
  {
    id: "library-member",
    title: "文件库 · 普通成员",
    description: "普通成员看到的文件名优先乐谱库。",
    device: "portrait",
    identity: "member",
    route: "/choirs/visual-choir",
    ready: { type: "selector", selector: ".file-list" },
    actions: [],
  },
  {
    id: "library-admin",
    title: "文件库 · 管理员",
    description: "管理员可见上传、管理和单文件操作。",
    device: "portrait",
    identity: "admin",
    route: "/choirs/visual-choir",
    ready: { type: "role", role: "button", name: "上传 PDF" },
    actions: [],
  },
  {
    id: "library-upload-dialog",
    title: "文件库 · 上传 PDF",
    description: "管理员打开上传界面后的状态。",
    device: "portrait",
    identity: "admin",
    route: "/choirs/visual-choir",
    ready: { type: "role", role: "dialog", name: "上传 PDF" },
    actions: [
      { type: "clickRole", role: "button", name: "上传 PDF" },
    ],
  },
  {
    id: "reader-clean",
    title: "阅读器 · 纯净视图",
    description: "默认隐藏控制界面的横向 iPad 阅读状态。",
    device: "landscape",
    identity: "member",
    route: "/choirs/visual-choir/scores/visual-score",
    ready: { type: "selector", selector: ".page-reader__viewport canvas" },
    actions: [],
    waitsForPdf: true,
  },
  {
    id: "reader-controls",
    title: "阅读器 · 显示控制",
    description: "轻点页面中央后显示的阅读器控制。",
    device: "landscape",
    identity: "member",
    route: "/choirs/visual-choir/scores/visual-score",
    ready: { type: "selector", selector: ".reader-chrome" },
    actions: [
      { type: "clickCenter", selector: ".page-reader__viewport" },
    ],
    waitsForPdf: true,
  },
  {
    id: "reader-layers",
    title: "阅读器 · 图层",
    description: "从隐藏控制进入图层面板后的状态。",
    device: "landscape",
    identity: "member",
    route: "/choirs/visual-choir/scores/visual-score",
    ready: { type: "selector", selector: ".reader-panel" },
    actions: [
      { type: "clickCenter", selector: ".page-reader__viewport" },
      { type: "clickRole", role: "button", name: "更多" },
      { type: "clickRole", role: "button", name: "图层" },
    ],
    waitsForPdf: true,
  },
];

export function validateVisualReportScenarios(scenarios = visualReportScenarios) {
  const ids = new Set();
  for (const scenario of scenarios) {
    if (!/^[a-z0-9-]+$/.test(scenario.id)) {
      throw new Error(`Invalid visual report scenario id: ${scenario.id}`);
    }
    if (ids.has(scenario.id)) {
      throw new Error(`Duplicate visual report scenario id: ${scenario.id}`);
    }
    ids.add(scenario.id);
    if (!new Set(["portrait", "landscape"]).has(scenario.device)) {
      throw new Error(`Invalid device for scenario ${scenario.id}`);
    }
    if (!new Set(["guest", "member", "admin"]).has(scenario.identity)) {
      throw new Error(`Invalid identity for scenario ${scenario.id}`);
    }
    if (!scenario.route.startsWith("/")) {
      throw new Error(`Scenario route must be absolute: ${scenario.id}`);
    }
  }
  return scenarios;
}
