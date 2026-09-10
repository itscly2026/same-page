# #268 云盘导航新鲜度与验证

目录、基本信息、本人云盘显示名与用量采用 60 秒内存新鲜期；成功完整读取才续期。过期后在访问、前台或联网事件中合并刷新，不新增计时轮询。手动刷新绕过新鲜期。成员名单只在打开权限说明时读取，成员、邀请码、回收站等仍有独立受保护请求。

离线保留内容与入口展示，但下载和云端修改独立要求联网，不能把近期权限确认当作网络可用。

新鲜期只控制客户端是否请求；每个实际云端请求仍按当前权限授权。持久化目录不授予操作权。在线身份或有效 session 变化清除导航确认，明确拒绝清除对应资源，暂时网络失败保留内容。修改后的失效按当前云盘及受影响资源传播，旧请求不能覆盖确认结果；跨账号请求也不能使缓存重新有效。

共享读取由资源而非页面组件拥有。多个消费者共享进行中的请求；目录最后一个消费者离开时，让正在进行的读取完成，再释放本地订阅。跨会话的重置立即终止旧生命周期。缓存仅保留有限个未活跃资源。

## 本地测量（2026-09-10）

固定场景：一个已登录拥有者、一份 PDF、默认共享层；首次进入目录，随后十次“基本信息 → 返回”，始终处于新鲜期，不展开权限说明、不进行编辑。

浏览器用真实客户端和合成 API 响应验证请求时机。数据库部分用真实本地 Worker/D1 分别测量下列接口，再按新旧客户端请求序列累计；不是生产账单，不是两套完整生产浏览器会话的 SQL 抓包，也不将取消请求算作已避免执行。服务器业务查询未修改，所以两边使用同一套逐接口成本。首次登录状态请求两边各计一次；其他与本导航无关的初始化请求未计入。

| 接口 | 每次 SQL | D1 读行 | D1 写行 | 旧序列次数 | 新序列次数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| bootstrap | 4 | 6 | 0 | 11 | 1 |
| settings | 8 | 7 | 0 | 11 | 1 |
| management | 9 | 17 | 0 | 10 | 1 |
| memberships | 6 | 8 | 0 | 10 | 0 |
| usage | 6 | 8 | 0 | 10 | 1 |
| DELETE guest/session | 0 | 0 | 0 | 11 | 0 |
| get-session | 6 | 5 | 3 | 1 | 1 |
| **累计** | **348 → 33** | **478 → 43** | **3 → 3** | **64** | **5** |

访客 Cookie 清理改由 bootstrap 在确认成员/登录体验访问后，通过响应清除已有 Cookie；真正依赖访客准入的读取保留 Cookie。减少 11 个清理请求并不减少 SQL，因为该接口本来就不访问 D1。

get-session 的 3 行限流写入没有变化，应独立优化；本卡没有开启 Better Auth cookieCache，也没有延长服务端授权。

## 复验入口

- `NODE_OPTIONS=--no-experimental-webstorage npx vitest run --config vitest.client.config.ts --maxWorkers=4`
- `npx vitest run --config vitest.worker.config.ts worker/scores-flow.test.ts`：本地 D1 计量通过 test annotation 记录，不冻结数据库查询计划；同时覆盖成员 bootstrap 清理 Cookie 与非成员访客 Cookie 保留。
- `node --test --test-global-setup=./visual-report/setup.mjs visual-report/navigation-freshness.test.mjs visual-report/drive-library-lifecycle.test.mjs`：Chromium/WebKit 十次往返、过期并发刷新、菜单稳定、返回位置与失败重试。
- 原有 `drive-navigation.test.mjs`、`drive-settings.test.mjs` 验证导航和修改流程。

新增回归覆盖：新鲜期不随访问延长、强制刷新与并发去重、失败不续期、迟到响应不能覆盖修改、同用户 session 更换、跨页面进行中的目录读取、失权后的本机保留内容与登录缺失的区别。

本地浏览器通过不代表已部署或真实 iPad/PWA 验收。截图与浏览器证据在 `artifacts/verification/navigation-freshness/`，不提交含浏览器状态的原始 trace。
