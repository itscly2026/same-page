# #134 验证与发布记录

审查基线：`3d8eb3a995ef958955c4a318e6873345d8703da7`。本记录对应 #134 实施提交。初次本地验证后，按用户指示完成推送与生产发布；上线证据记录在末节。

## 结果

- `npm run check:full`：197.02 秒，成功。包含 CI 范围回归、lint、typecheck、Node/shared 34、客户端 257、Worker unit 7、Worker integration 55、浏览器 31、迁移、生产构建、真实存储 smoke、真实 PWA 更新及性能门禁。
- 正常并发配置的浏览器套件连续三次成功：48.46 秒、43.92 秒、51.73 秒（第三次在 check:full 内）。全部保持 `--test-concurrency=2`，没有用例重试，未出现 SQLite 锁争用。
- 审查新增两条回归：fixture 准备期间 SIGTERM 必须等待资源释放；新入口与旧 preload 混合必须拒绝。均先复现失败，再验证修复。
- 验证最终生成产物：真实 preview 返回的全部 40 个 JS/MJS 与已封存清单逐个匹配；测试只转换本地 URL，不替换 HTTP 响应。封包额外核对磁盘最终脚本，避免 Vite 后续改写导致摘要过早生成。
- 真实 smoke：真实访客准入、D1 乐谱/图层、R2 PDF 完整字节、产品下载至 IndexedDB；停止 Worker 后关闭并重启持久化 Chromium，断网仍渲染谱面，API 请求不可达。没有 API mock、预填 IndexedDB 或测试 HTTP 后门。
- 发布 tar 已解包到另一临时目录，清单校验与 Wrangler `deploy --dry-run` 均通过，确认不依赖原 checkout 的构建目录；此命令不执行生产写入。
- Actions 工作流经 actionlint 1.7.12 静态校验。Standards/Spec 双轴审查分别发现并修复上述两处边界，复核均通过。审查后对受影响的测试、PWA、构建、smoke 和性能补测，不重复无关套件。

完整日志与三次时序位于本地 `artifacts/verification/`；此目录仅容纳合成测试内容，不提交生成文件。CI 会保留可用的合成测试证据，并把源码、artifact ID/digest 写入 summary。

## 时间基线与适用范围

当前基线的真实 Actions [运行 33939561018](https://github.com/itscly2026/same-page/actions/runs/33939561018)：verify 310 秒、deploy 62 秒，从 verify 开始到 deploy 完成约 375 秒；其中部署阶段重新构建耗时 14 秒。它是客户端变更的按范围执行，未运行 Worker/PWA/迁移步骤，不能与本次本地全量 197.02 秒直接比较。

此次发布链移除了 deploy 的一次构建；完整 verify 仍保留两个 PWA 合成构建和一个正式构建。新增 artifact 传输、摘要核对和真实 smoke 有额外耗时，不能把删掉的 14 秒直接声称为净加速。

修改后的真实 Actions 与生产证据见下方。此处不以本地耗时代替 CI；#9/#39 继续独立跟踪设备和外部身份提供方。

## 2026-09-05 生产发布

- 源码与线上 buildId：`c0f1487ca8f1e26d86d65066e4e2c627d258b60b`。
- [Actions 33971285548](https://github.com/itscly2026/same-page/actions/runs/33971285548)：verify 与 deploy 均成功。verify 475 秒，deploy 69 秒，关键路径约 548 秒。本次运行完整范围，包含 Worker、PWA、迁移与真实存储 smoke；基线客户端范围为 375 秒，范围不同，不宣称净提速。部署端的重复构建已移除，产物传输、准入记录和更完整的线上验收各有额外成本。
- [验证产物 9971102044](https://github.com/itscly2026/same-page/actions/runs/33971285548/artifacts/9971102044)：`release-c0f1487ca8f1e26d86d65066e4e2c627d258b60b`；GitHub artifact digest 为 `sha256:ac3b758d7726e40c8293e2e6385171db59c4396e3064ae16b7d307f9ba89c7a7`。独立下载后核对 87 个文件与清单、源码和验证 run ID，一致。
- GitHub `production-release` 发布记录：`6282022209`，源码为上述 SHA。
- D1：恢复点及迁移前聚合已记录；没有新 migration 需要应用。迁移后列、外键及同步游标核查通过。
- Cloudflare Worker version：`598372d6-768a-49d2-a653-57becd5305fb`。直接部署 CI 产物，部署 job 没有重新构建。
- 线上独立验收：以 CI 下载的 `dist/client/build.json` 为依据，核对 Worker、应用壳、构建身份、全部 40 个脚本摘要、manifest、Service Worker、第三方入口边界及未登录 401，全部通过。
- Chromium 与 WebKit 的线上首页、公开云盘访问及 PDF 渲染均通过，未出现页面异常。结果另存本地 `artifacts/verification/production-browser.json`；桌面浏览器引擎自动化不代表 #9/#39 的真实设备和外部身份提供方验收。

本记录后续仅文档提交不触发部署，生产身份继续指向上述产品源码 SHA。
