const readerRoute = "/choirs/visual-choir/scores/visual-score";
const driveRoute = "/choirs/visual-choir";
const showControls = { type: "clickCenter", selector: ".page-reader__viewport" };
const click = (role, name) => ({ type: "clickRole", role, name });
const role = (role, name) => ({ type: "role", role, name });
const selector = (selector) => ({ type: "selector", selector });
const text = (text) => ({ type: "text", text });
function scene(id, title, description, route, ready, actions = [], extra = {}) {
  return { id, title, description, device: "narrow", identity: "member", route, ready, actions, ...extra };
}
function reader(id, title, description, ready, actions = [], extra = {}) {
  return scene(id, title, description, readerRoute, ready, actions, { waitsForPdf: true, ...extra });
}
export const extraVisualReportScenarios = [
  scene("home-continue-reading", "首页 · 继续上次阅读", "仅展示当前用户仍可访问的最近乐谱与有效页码。", "/", selector(".continue-reading a"), [], { device: "portrait", seedContinue: true }),
  scene("home-guest-mobile", "首页 · 手机入口", "双语品牌说明与进入云盘入口。", "/", role("button", "进入云盘"), [], { identity: "guest" }),
  scene("home-guest-desktop", "首页 · 桌面入口", "品牌说明与进入云盘入口。", "/", role("button", "进入云盘"), [], { identity: "guest", device: "desktop" }),

  scene("library-empty", "文件库 · 空库", "空库给管理员明确上传入口。", driveRoute, selector(".library-empty-state"), [], { identity: "admin" }),
  scene("library-search-none", "文件库 · 搜索无结果", "保留云盘总数，并提供清除搜索。", driveRoute, role("button", "清除搜索"), [{ type: "fillRole", role: "searchbox", name: /搜索.*中的乐谱/, value: "不存在的乐谱" }]),
  scene("library-long-list", "文件库 · 长文件名与列表", "30 份长名称乐谱，名称、排序和离线状态并存。", driveRoute, selector(".file-list .file-row:nth-child(8)")),
  scene("library-upload-partial", "文件库 · 上传部分失败", "两个虚构 PDF 分别成功与超过大小限制；重试队列归 #104。", driveRoute, text("PDF 超过 20 MB。"), [click("button", "上传 PDF"), { type: "uploadSamples" }, { type: "waitVisible", selector: ".upload-list [data-status=success]" }], { identity: "admin" }),
  scene("preferences-mobile", "我的偏好 · 手机", "默认显示优先，颜色与恢复为次级操作。", `${driveRoute}/preferences`, selector(".preference-row:last-child")),
  scene("preferences-load-failure", "我的偏好 · 读取失败", "故意注入 503，原位提供重新加载。", `${driveRoute}/preferences`, role("button", "重新加载")),
  scene("preferences-load-retry", "我的偏好 · 重试恢复", "首次读取 503 后通过重试重新读取设置。", `${driveRoute}/preferences`, selector(".preference-row:last-child"), [click("button", "重新加载")]),
  scene("preferences-color-restore", "我的偏好 · 恢复云盘颜色", "取消 E 层个人颜色后刷新，接口夹具返回持久化结果。", `${driveRoute}/preferences?view=colors`, selector(".preference-row:first-child input[type=color]"), [click("button", "Ensemble 恢复默认颜色"), { type: "waitText", text: "已保存" }, { type: "reload" }]),
  scene("settings-permission-denied", "云盘管理 · 权限拒绝", "普通成员访问管理地址得到 403，不显示管理控件。", `${driveRoute}/shared-layers`, text("你没有操作此设置的权限，请联系云盘拥有者。")),
  scene("shared-layer-management-mobile", "云盘管理 · 手机共享层", "共享层、授权人数与默认颜色紧凑排列。", `${driveRoute}/shared-layers`, selector(".settings-layer-row:nth-child(5)"), [], { identity: "admin" }),
  reader("reader-tools-mobile", "阅读器 · 手机笔记工具", "当前层、文本、画笔、橡皮、撤销与重做完整可见。", role("button", "重做"), [showControls, click("button", "编辑")]),
  reader("reader-layer-save-failure", "阅读器 · 显示设置保存失败", "故意注入 503，保留原值并显示恢复动作。", selector(".reader-layer-feedback"), [showControls, click("button", "看哪些笔记"), click("checkbox", "显示 Ensemble")]),
  reader("reader-dense-portrait", "阅读器 · 密集 SATB 与歌词", "原创八页排版样本，以四声部、多系统与音节检验阅读密度。", text("换气"), [], { device: "portrait", dense: true }),
  reader("reader-dense-pages", "阅读器 · 八页定位", "缩略图显示八页及不同纸张比例。", selector(".page-preview-strip"), [showControls, click("button", "页面位置")], { device: "landscape", dense: true }),
  reader("reader-dense-continuous", "阅读器 · 连续阅读", "密集多声部样本按各页尺寸连续呈现。", selector('.continuous-reader__page[data-index="0"] [data-pdf-canvas-active]'), [showControls, click("button", "更多"), click("button", "连续滚动"), click("button", "更多")], { device: "portrait", dense: true }),
  reader("reader-offline-ready", "阅读器 · 离线副本校验完成", "下载 PDF 与数据并校验后才显示可离线。", text("可离线使用"), [showControls, click("button", "更多")]),
  reader("reader-offline-failure", "阅读器 · 离线下载失败", "离线元数据下载注入 503，提供重试并按已校验副本反馈可用性。", role("button", "重试下载离线副本"), [showControls, click("button", "更多"), { type: "armFailures" }, click("button", "下载离线副本")]),
  scene("preferences-display-save", "我的偏好 · 保存默认显示", "关闭 E 默认显示后刷新，保留用户设置。", `${driveRoute}/preferences`, selector('.preference-display-toggle input[aria-label="Ensemble 默认显示"]:not(:checked)'), [click("checkbox", "Ensemble 默认显示"), { type: "waitText", text: "已保存" }, { type: "reload" }]),
  scene("shared-layer-grants-save", "云盘管理 · 保存编辑授权", "取消普通成员编辑授权后刷新；管理员仍始终可编辑。", `${driveRoute}/shared-layers/E`, selector('.settings-member-row input[aria-label="周宁"]:not(:checked)'), [click("checkbox", "周宁"), { type: "waitText", text: "编辑权限已更新。" }, { type: "reload" }], { identity: "admin" }),
  reader("reader-layers-mobile-personal", "阅读器 · 手机个人层", "手机面板滚动到底，显示个人层与隐私说明。", selector(".layer-section--personal .layer-card"), [showControls, click("button", "看哪些笔记"), { type: "scrollIntoView", selector: ".layer-section--personal .layer-card" }]),
  reader("reader-dense-landscape-page", "阅读器 · 混合纸型第三页", "八页定位跳到横向纸张，重新适合整页并保持中心定位。", selector('.page-reader__sheet[data-page-turn-current][data-page-number="3"] [data-pdf-canvas-active]'), [showControls, click("button", "页面位置"), click("button", "前往第 3 页")], { device: "landscape", dense: true, expectedAnnotation: false }),
  scene("pwa-registration-success", "PWA · 注册成功", "真实 Service Worker 激活后静默准备应用资源；不表示乐谱可离线。", "/", role("button", "进入云盘"), [], { identity: "guest", pwa: "success" }),
  scene("pwa-registration-failure", "PWA · 注册失败", "仅此专项注入首次注册拒绝，保留真实错误反馈。", "/", role("button", "重试"), [], { identity: "guest", pwa: "failure" }),
  scene("pwa-registration-retry", "PWA · 注册重试成功", "首次注册拒绝后重试真实浏览器注册，等待激活。", "/", role("button", "进入云盘"), [click("button", "重试"), { type: "assertHidden", selector: ".update-prompt" }], { identity: "guest", pwa: "retry" }),
];
