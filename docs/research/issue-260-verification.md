# Issue #260 本地验证

实现使用手册与独立页脚入口、文档更新日期、当前客户端版本发布日期、创建云盘闲置提示，并移除微信认证及其占位邮箱分支。微信内置浏览器安装指引仍适用，与认证提供方无关。

- 构建时按 Asia/Shanghai 写入不可变的版本发布日期；客户端显示随本次制品打包的日期，不读取远端最新版本时间。文档日期随内容修订维护。
- 原生锚点会绕过 React Router，在曾打开弹窗的导航历史中产生无效 POP；目录使用路由内 replace 跳转并滚动、聚焦章节，避免污染返回历史。
- 本地通过构建、类型检查、lint、相关客户端测试（74 项）及完整 Worker 测试（10 项单元、108 项集成）。
- `node scripts/preview-product-info.mjs` 启动合成数据预览，地址为 `http://127.0.0.1:4177/drives`；随后运行 `node scripts/verify-product-info-preview.mjs`，验证 390px 与 1280px 下的公共导航、账户菜单、创建提示、目录跳转与折叠。
- 截图位于 `artifacts/verification/issue-260/`。预览使用合成用户与云盘，不代表生产数据或真实设备验收；本地认证集成使用模拟 Google OAuth，不代表生产 Google 授权验收。

闲置规则仅作告知，无新增自动清理、追踪或邮件发送逻辑。人工执行要求见 [闲置检查 runbook](../runbooks/idle-drive-review.md)。
