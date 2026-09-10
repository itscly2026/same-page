# PDF 图片解码资源

PDF.js 的 worker 不是全部运行时依赖。当前版本使用 `jbig2.wasm` 解码
CCITT / JBIG2 图片，使用 `openjpeg.wasm` 解码 JPEG2000，并使用
`qcms_bg.wasm` 处理 ICC 色彩。缺失图片解码器时，PDF.js 可能只打印 warning、
跳过图片并成功结束 render promise，导致扫描型 PDF 显示为白纸。

`src/shared/pdfjs-assets.ts` 定义随安装版本发布的资源目录和文件清单；
`scripts/pdfjs-assets-plugin.ts` 在开发环境提供同一组文件，在客户端构建中发布
原始文件及其许可证。目录带 PDF.js 版本号，fallback 文件名保持不变，供 worker
动态导入。在线 URL、候选 PDF 和离线 ArrayBuffer 都通过 `loadPdfDocument`
使用这个目录，不依赖外部 CDN。

解码 wasm 与 JavaScript fallback 必须一起进入 PWA 预缓存。部分浏览器无法
编译特定 WebAssembly 指令时仍需要 fallback；只缓存 wasm 不足以支持离线阅读。
升级 PDF.js 时，核实文件清单、许可证和实际产物，不能只检查 worker。
`npm run build` 的预缓存审计会拒绝缺失解码依赖或许可证的产物。

两个 JS fallback 也属于 `build.json` 的脚本哈希清单。发布封存和部署校验
共用 `scripts/deployment-identity.mjs` 中的路径规则，并验证最终文件字节；
该模块不依赖 npm 包，以支持安装依赖前的产物校验。版本目录通过 `_headers`
设置 immutable 缓存。升级时如 fallback 名称或版本目录格式改变，须同步更新
路径规则并运行发布、部署回归测试。

验证：

- `node --test browser-tests/pdf-codecs-smoke.test.mjs`：先构建，使用真实本地
  Worker / D1 / R2 和原创两页 PDF，检查 CCITT 与 JPEG2000 页面的黑色中心和
  白色边角，再通过产品下载离线副本、关闭服务并重新打开，重测两页内容。
  Chromium 同时开启浏览器 offline 标志；WebKit 以真实源站关闭验证不可达场景，
  避开其模拟 offline 导航内部错误。这不代表真实 iPad 的断网验收。
- `browser-tests/fixtures/generate-image-codecs.py` 用 Pillow 生成该 PDF；图形完全
  原创，不含用户谱子。Python 环境需支持 TIFF Group 4 和 JPEG2000。
- 构建预缓存检查也覆盖两个 JS fallback；不要因某一浏览器当前能执行 wasm
  就删除备用资源。

测试检查像素是因为已知这个样本一定有图形。产品不应对任意 PDF 使用“白页即
错误”的规则；合法 PDF 可以包含真正的空白页。

## legacy 支持边界

阅读器主模块与 PDF Worker 统一使用同版本 legacy，决定见 [ADR0013](../adr/0013-use-legacy-pdf-display.md)。实际安装的 6.3.289 包仍要求 `Promise.withResolvers`，没有内置它的 polyfill；其中 `Iterator`、`Promise.try`、Map upsert 的补充不能推导为任意旧浏览器兼容。

能力验证分开执行并记录结果：保留 `Promise.withResolvers`、移除 legacy 已补充的 API 后检查实际谱面绘制；另行移除 `Promise.withResolvers` 后检查明确的 `engine-unavailable`，并验证仍能下载原 PDF。不能把“移除全部 API”后的失败当作受支持环境的绘制结果，也不能以 canvas 存在替代非空内容。两个探针都不能替代 Safari 17.5 真机验收；当前该真机尚未验证，不附带 legacy 性能结论。
