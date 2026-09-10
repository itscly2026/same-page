# 合谱 · Same Page

合谱是一款面向合唱排练的乐谱 Web/PWA。成员围绕同一份 PDF 乐谱使用云盘配置的共享批注层，并保留或按谱分享自己的个人层。界面适配平板、桌面和手机。

生产站点：[samepage.clyapps.com](https://samepage.clyapps.com)。项目仍在快速开发；当前工作与验收进度见 [GitHub Issues](https://github.com/itscly2026/same-page/issues)。合并、部署和真实设备验收分别以对应 PR 的记录为准。

## 开发入口

使用 Node.js 24 与 npm。客户端为 React/TypeScript/Vite；同源 API 使用 Cloudflare Worker/Hono、Better Auth、D1 和 R2。PDF 阅读统一使用 PDF.js legacy；本地草稿与离线副本使用 Dexie/IndexedDB。

```bash
npm ci
```

按 [本地初始化](docs/runbooks/local-development.md) 配置开发环境、迁移本地数据库并创建首个云盘，再启动：

```bash
npm run dev
```

Cloudflare Vite plugin 同时运行客户端和 Worker；`/api/*` 进入 API，其余页面路径由 React 路由处理。

## 验证入口

```bash
npm run lint
npm run typecheck
npm test                 # Node 规则与 React/jsdom
npm run test:worker       # Worker 单元与真实 D1/R2 集成
npm run build            # 类型检查、生产构建、预缓存审计
npm run check            # 常规全套，包含浏览器测试
npm run check:full       # 再含原生渲染、PWA 更新和加载预算
npm run visual:report    # 当前产品的视觉报告
```

浏览器、Python 依赖及各测试职责见 [CI 检查与开发反馈](docs/operations/ci.md)。完整检查会多次构建，不应与其他构建命令在同一工作目录并行运行。测试和视觉报告不需要生产凭据，不执行生产迁移或部署。

## 文档导航

| 要了解的内容 | 入口 |
| --- | --- |
| 云盘、成员关系、图层、乐谱版本与离线副本的领域含义 | [CONTEXT](CONTEXT.md) |
| 设计取舍及被取代的决定 | [ADR](docs/adr/)；当前图层决定见 [ADR-0014](docs/adr/0014-configurable-and-published-layers.md) |
| 本地认证配置、云盘初始化、认证 schema 生成 | [本地开发 runbook](docs/runbooks/local-development.md) |
| 文件库加载、缓存与返回位置 | [文件库架构](docs/architecture/drive-library.md) |
| PDF 验证、候选、发布、回滚与清理 | [PDF 生命周期 runbook](docs/runbooks/pdf-version-lifecycle.md) |
| PDF.js 解码资源与扫描 PDF 验证 | [PDF 解码资源 runbook](docs/runbooks/pdf-rendering-assets.md) |
| 用户删除、成员退出与恢复 | [用户生命周期 runbook](docs/runbooks/user-lifecycle.md) |
| 诊断提交与故障排查 | [故障诊断](docs/operations-diagnostics.md) |
| 测试范围、视觉报告和本地全套检查 | [CI 检查与开发反馈](docs/operations/ci.md) |
| 发布产物与顺序约束 | [交付契约](docs/operations/delivery-contract.md) |
| 生产配置、第三方登录、发布恢复、邮件与实机验收 | [发布 runbook](docs/operations/production-release.md) |
| Issue 使用约定 | [Issue tracker](docs/agents/issue-tracker.md) |

领域规则在 CONTEXT 中维护，决策理由在 ADR 中维护，操作步骤在对应 runbook 中维护。`docs/operations/verification-*` 和测试审查记录保留各自提交基线的历史证据。

浏览器仿真不能证明真实 iPad/Pencil、PWA 存储驱逐、中国大陆网络或邮件投递表现；这些验收按发布 runbook 单独记录。

## 许可证

本项目原创代码采用 [GNU Affero General Public License v3.0](LICENSE)（SPDX：`AGPL-3.0-only`）。允许在遵守许可证的前提下使用、修改和商业运营。分发以及修改后提供网络服务时，应按许可证要求提供对应源码；完整权利和义务以 LICENSE 为准。

第三方代码、字体及素材继续适用各自的许可证。代码许可不授予以本项目名称或标识冒充官方服务的权利，也不授予用户上传谱面或其他用户内容的使用权。
