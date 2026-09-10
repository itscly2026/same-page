# 统一 PDF.js legacy 谱面显示（#156）

本决定取代原独立图片恢复架构。阅读器统一使用当前依赖版本的 PDF.js legacy，主模块与 PDF Worker 必须配套；不保留 modern/legacy 动态分流、图片模式、服务端图片派生或图片离线副本。选择单路径是为了收敛运行和维护边界，不推测 legacy 的性能优劣，也不据此宣称 Safari 17.5 已兼容。

实际安装的 `pdfjs-dist 6.3.289` legacy 包补充了 `Iterator`、`Promise.try` 和 Map upsert，但仍直接调用 `Promise.withResolvers`，没有提供它的 polyfill。因此 legacy 不代表能够解决全部 API 缺失。受支持能力绘制探针保留 `Promise.withResolvers`，只移除由 legacy 补充的 API；另一个缺少 `Promise.withResolvers` 的探针应验证明确的 `engine-unavailable` 与可用的原 PDF 下载入口。探针结果与真机验收分别记录，不能将计划中的验证写为通过。

PDF 版本仍是不可变原文件，离线副本由经校验的 PDF 与笔记快照构成。移除旧图片记录不得删除个人草稿、待同步操作、冲突或目录；已有纯图片副本需要重新联网下载 PDF，不能被计为可用的 PDF 离线副本。

专属 PDFium renderer、Cloud Run 发布链、图片 Queue 绑定和 CI renderer gate 一并移除。PDF 上传验证属于 Worker 的独立 PDF 验证逻辑，不依赖该服务。PDF 内嵌图片的 codec WASM、解码器脚本、正常产品图片与审查截图继续保留。

已上传的 Durable Object migration tag 及对应删除类 migration 保留，不能重写部署历史。资源解绑不等于远端资源已删除；按 [生产退役步骤](../operations/image-renderer-retirement.md) 分阶段处置。

Safari 17.5 真机尚未验证；桌面 Chromium/WebKit、模拟缺失 API 或本地测试均不能替代目标 Safari/PWA、手写笔及实际排练验收。
