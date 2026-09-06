# 设计来源

应用图标母版保存在本目录。运行时只发布 public 中的五个正式尺寸图标。
设计来源不能复制到 public 或由客户端导入；构建审计按文件内容检查发布目录和实际 Workbox 清单，防止改名后再次发布。

首页产品截面使用自有合成谱面 `Rehearsal Study`，经实际 PDF 阅读器渲染并叠加示例批注。运行 `node scripts/generate-home-preview.mjs` 可重新生成 `src/client/assets/home/reader-preview.png`；脚本和合成谱面数据为设计来源，PNG 是有意发布的产品图片。不含真实云盘内容。
