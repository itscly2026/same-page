# #225 阅读状态与偏好持久化验证

## 行为与边界

配置读取分别记录内容、请求和权限确认；暖启动保留缓存内容，确认前不开放管理写入。显示名按用户和云盘保存已知值与修订号，后台刷新不覆盖脏输入。已确认的修改与随后读取失败分别反馈，重试只重读。

阅读偏好先反馈到谱面，再通过 IndexedDB 事务保存；内部区分正在保存、本机失败、待同步和已同步；#238 后正常保存过程静默，界面仅呈现失败及重试。同项最后意图在 Web Locks 内串行发送，其他项独立推进；重开与网络恢复可重新发送。没有 Web Locks 时保留本机待同步并提示，不能声称已同步。偏好投影只改变已有层的显示字段，不增加层或授予权限。账户切换、退出和已确认退盘阻止旧会话继续回写。

## 自动化证据

- Node 单元：21 文件、79 项通过。
- Worker 单元：5 文件、10 项通过；集成：10 文件、99 项通过。新增的偏好和显示名身份不匹配检查覆盖 3 个 PUT、1 个 PATCH、2 个 GET，最终定向回归通过。
- 客户端覆盖延迟请求、连续选择、读取旧响应、本机存储失败、重新打开数据库、身份切换、继承恢复、脏显示名修订冲突，以及已保存后刷新失败。完整回归曾有一个冷启动用例超时，独立重跑通过；没有放宽等待时间。最终降低并行度的完整回归 57 文件、496 项全部通过。
- 最终定向回归另覆盖无 Web Locks 时保留本机 pending 且不发送请求；相关 2 文件、7 项通过。typecheck、lint、生产 build 与 precache 检查通过。
- Chromium / WebKit 既有层偏好场景均通过，失败后的预期改为保留本机选择并明确重试。
- 新增 `visual-report/reading-state.test.mjs` 在 1440 × 900 和 390 × 900 视口通过：受控挂起 HTTP 响应期间，谱面与勾选先变化、其他层仍可操作、最后选择保留、显示名暖打开有值且刷新不覆盖编辑、没有横向溢出。桌面另开共享存储的第二标签页，验证同项请求串行与最后选择发送。
- Standards 与 Spec 两轴审查的问题已修复：跨标签页互斥、管理权限读取重试、过时已观察颜色重发、持久化完成到实时查询更新之间的显示闪回。

复现浏览器证据：`node --test visual-report/reading-state.test.mjs`。截图与断言记录生成在 `artifacts/issue-225/`，包含桌面/窄屏 pending preference、warm name 和 `checks.json`，不提交生成图片。

本机 Node 25 运行客户端测试时使用 `NODE_OPTIONS=--no-experimental-webstorage`，避免 Node Web Storage 与 jsdom 存储冲突；客户端完整回归使用 `--maxWorkers=2` 控制资源竞争。

## 验收范围

以上为本机自动化、浏览器 fixture 和截图检查。未部署、未进行真实 iPad / 手机 PWA 或真实排练验收；窄视口不是设备验收。#226 的导航和视觉重做不在本次范围内。

## PR #228 CI 修复

首次 CI 的 `checks` 和 `integration` 通过，`visual` 的 Chromium / WebKit 显示名与云盘改名场景仍等待旧文案“成员与权限（需联网）”而超时，`verify` 随此失败。本机用 `node --test --test-name-pattern='chromium:' visual-report/drive-settings.test.mjs` 复现相同断言失败。更新该场景以验证在线刷新失败后的真实状态：菜单保留、成员入口禁用且不存在管理链接、显示集中权限确认提示、不出现旧的逐项离线标签。未修改产品逻辑或放宽超时。

修正后使用 CI 同样的共享服务方式 `node --test --test-global-setup=./visual-report/setup.mjs visual-report/drive-settings.test.mjs`，Chromium / WebKit 共 4 项全部通过。直接逐场景启动的补跑曾在最后一个场景清理子进程时遇到本机 `kill EPERM`；该结果未记作完整通过，未为此修改进程管理逻辑。
