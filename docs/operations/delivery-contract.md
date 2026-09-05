# 验证与交付契约

本次实现 #134，基线 `3d8eb3a995ef958955c4a318e6873345d8703da7`。

## 版本与发布

- buildId 是确切源码 SHA。验证阶段最后一次生产构建生成 Worker、应用壳和客户端资源；PWA 的两个合成版本不能进入发布包。
- 发布包包含完整 dist、对应 migrations、运行配置与 SHA256 清单。部署 job 核对清单与源码 SHA，直接部署包内 Worker 和 assets，不重新构建。
- 所有生产写入都在同一个不可取消的部署锁内。在 GitHub Deployments 的 `production-release` 环境记录发布尝试，先登记再迁移。记录即为单调推进边界：旧祖先不能越过新的尝试（包括失败）；同 SHA 可重试，分叉历史拒绝自动发布。后续文档提交不会推进这个边界。
- 失败后优先在原 SHA 重试或发布后继修复；回滚通过新的 revert 提交向前发布，数据库恢复必须单独核查。第一次启用记录时也核对线上 Worker SHA，防止既有发布比本次更新。
- 线上验收必须显式提供 expected buildId 和已验证发布包的脚本清单（CLI 默认读取 dist/client/build.json）；Worker、build.json、HTML 必须匹配 SHA，全部构建脚本必须逐个匹配清单中的 SHA256。传播重试有界，最终失败不能标记发布成功。

## 测试资源所有权

每个自动化 Vite 服务拥有一个临时目录和一个独立进程组；D1/R2 状态、Vite 缓存均在该目录。启动前可用本地绑定 API 准备合成 fixture，必须先释放准备进程再启动 Vite。prepare 接收 AbortSignal，在 await 边界检查取消，并在 finally 释放绑定；退出时先取消并等待准备过程结束。调用者拥有浏览器 context，并在 finally/after 清理；服务停止、启动失败和信号退出释放进程组及目录。不读取本机开发凭据，不接触日常 `.wrangler/state`。

现有视觉/性能测试保留 API fixtures。新增真实链路 smoke 使用生产 API 和本地 D1/R2，浏览器通过产品操作保存并重新打开 IndexedDB 离线副本；无需新增测试 HTTP 后门。产品票可复用同一 fixture 生命周期扩展批注场景。

## 回归边界

使用发布准入、发布包校验、部署验收、服务器启动/退出、CI 范围分类和浏览器可见行为作为测试接口。保留现有组件、Worker、迁移、视觉、PWA 与性能门禁；不以重试掩盖失败。实际 Actions 耗时与本地命令耗时分别记录，尚未发布时不宣称 CI 或生产验收已完成。
