# PWA 安全区域

安装默认使用 standalone，阅读器仍可由用户主动进入 Fullscreen API。旧安装可能继续采用 fullscreen；安装识别兼容两者，不要求卸载或清理本机数据。

保留 viewport-fit=cover 和 black-translucent，让背景铺满屏幕。普通路由由 page-with-footer 消费四边安全区一次；子页面不重复补偿。顶部背景条保护滚动后的状态栏区域，sticky 云盘头部停在安全区下缘。body 不加 padding，阅读器独立几何布局保持不变。

body portal 不继承普通外壳的布局边界：modal-overlay 与 diagnostic-overlay 负责安全区，内部滚动内容使用扣除安全区后的可用高度。抽屉与固定按钮自行避让。--safe-* 的默认值来自 env(safe-area-inset-*)，测试可注入非零值检验布局，不代表模拟了系统状态栏。

运行 `node --test visual-report/safe-area.test.mjs` 验证 Chromium/WebKit。真实 iPad 需验证旧安装与新安装的首页、云盘、设置、弹窗、横竖屏和前后台恢复，并独立验收阅读器主动全屏。若系统错误上报零安全区，布局测试不能证明该平台问题已解决。
