# Production release runbook

本页把“代码通过”“已发布”“域名可达”“邮件可投递”和“实机验收”分开记录。任一项
通过都不能替代其余项目。

## 过期限流记录清理

沿用 `0 * * * *` 的每小时调度，每次最多删除 500 条 `window_expires_at <= 当前时间` 的限流记录，按到期时间从旧到新处理。未过期计数不变；到期时刻与原限流窗口重置条件一致。单条原子 SQL 同时选择和删除，并在删除条件中再次检查到期时间，没有分开扫描后误删已续期窗口的间隙。

`0012_rate_limit_expiry_index.sql` 只新增 `(window_expires_at, key)` 覆盖索引，不修改已有窗口或身份；迁移首次构建索引会读取现有记录并占用额外索引空间，之后每次窗口写入也维护索引。清理按索引取最多 500 个候选并按主键删除，不做全表计数、无界循环或跨批长事务。按默认调度，持续积压时最多每小时处理 500 条（每日 12,000 条），不是无限吞吐保证。

成功日志只有固定事件 `same_page_rate_limit_cleanup` 与 `removed` 数量（包括 0）；连续多次达到 500 说明可能存在积压，可再用受控只读聚合查询确认，不输出 key 或身份。失败沿用 `same_page_failure`，固定 `operation=auth`、`stage=cleanup`，不记录数据库原始错误。乐谱与限流清理分别注册 `waitUntil`，任一失败不阻止另一项执行，失败会继续向运行时抛出脱敏错误；下一次每小时调度可安全重试，不承诺平台自动补跑。

## 固定生产边界

- URL：`https://samepage.clyapps.com`
- Worker：`same-page`，关闭 `workers.dev` 与 preview URL
- D1：`same-page-production`（APAC）
- R2：`same-page-production-scores`（APAC、Standard）
- 邮件发件人：`Same Page <login@samepage.clyapps.com>`
- Resend 发信域：`samepage.clyapps.com`，与根域真人邮件/Webmail 信誉隔离
- Resend key：Same Page 独立、Sending access、只允许 `samepage.clyapps.com`
- CI Cloudflare token：Same Page 独立，包含 Workers Scripts Write、D1 Write、
  Workers R2 Storage Write、Account Settings Read、Workers Queues Write，以及
  `clyapps.com` 的 Workers Routes Write。PDF 渲染运行于 Google Cloud Run，不再需要 Workers Paid / Containers。

生产 Secret 只存在于 Resend、Cloudflare Worker 和 GitHub Actions 的 secret store。
不得写入仓库、Issue、PR、日志、终端历史或发布记录。

## 首次发布

首次发布由运维人员完成以下步骤：

1. 创建生产 D1 与 R2，并核对区域、名称和绑定。
2. 对生产 D1 执行全部 `migrations/`。
3. 在 Worker Secret 中设置彼此独立的 `BETTER_AUTH_SECRET`、`INVITE_SECRET` 与
   `RESEND_API_KEY_SAMEPAGE`。需要启用第三方登录时，再设置完整的 `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET` 和 `WECHAT_CLIENT_ID` / `WECHAT_CLIENT_SECRET`；缺少任意一项时
   对应入口会保持隐藏。
4. 部署前先在 Resend 验证 `samepage.clyapps.com` 的 SPF、DKIM、DMARC 与 Return-Path，
   创建仅允许该子域的 Sending-only key，并先写入尚未被当前版本读取的 Worker
   `RESEND_API_KEY_SAMEPAGE`。代码部署时才切换到该 Secret，避免旧发件人与新密钥不匹配；
   旧 Secret 和旧 key 仅保留到真实投递验收完成，以便回滚。发信子域记录不得改动根域 MX、
   Cloudflare Email Routing 或 Webmail；不得在域未 verified 时切换 From。
5. 部署 Worker 与静态资源；Wrangler 的 custom domain 配置负责创建 DNS 记录和证书。
6. 在 GitHub `production` environment 中设置 `CLOUDFLARE_API_TOKEN` 与
   `CLOUDFLARE_ACCOUNT_ID`。
7. 运行 `npm run verify:deployment -- https://samepage.clyapps.com <expected-source-SHA>`。
8. 首位管理员完成 OTP 注册后，通过受控命令创建“小红花云盘”。自动化命令不显示
   初始邀请码；管理员登录后在「管理 → 邀请码」查看，并通过私密渠道交付。
9. 如需启用“公开体验”，使用 `--guest-admission open --preview-entry` 创建唯一的公开体验云盘；已有开放准入云盘必须通过受控 SQL 明确设置 `is_preview_entry = 1`，不得按名称自动匹配。

## 认证邮件发送边界

- 标准化邮箱共享 60 秒冷却与 3 次/15 分钟窗口；客户端身份共享 10 次/15 分钟窗口。
  三者都由 Worker 执行，`429` 必须带 `Retry-After`，刷新或多标签页不能绕过。
- 为避免通过限流差异探测用户是否存在，可投递地址与不可投递地址都消耗相同发送门槛；实际
  成功发送数只会小于或等于门槛。D1 只保存 HMAC 后的邮箱和客户端标识，不保存原值。
- 注册和密码重设共用上述门槛；新 OTP 发出后旧 OTP 失效，有效期 10 分钟，每个 OTP 最多
  尝试 3 次。
- 邮件主题不得包含 OTP；text/HTML 正文必须说明 `samepage.clyapps.com`、用途、10 分钟
  有效期和非本人操作处理方式，不使用远程图片、营销内容或站外链接。
- Resend `Delivered` 只表示收件服务器接受。发布证据必须把 provider 状态、实际 Inbox/Spam
  位置和延迟分开记录，且不得包含 OTP、完整收件地址、Message-ID 或密钥。

## 第三方登录配置

- Google 使用 Web application OAuth client，授权回调固定为
  `https://samepage.clyapps.com/api/auth/callback/google`，只申请 `openid`、`email`、
  `profile`。OAuth 品牌配置中的应用首页为 `https://samepage.clyapps.com/`，隐私政策为
  `https://samepage.clyapps.com/privacy`，Authorized domain 填根域 `clyapps.com`（不带协议、
  子域或路径），并通过 Google Search Console 验证域名所有权。上线前单独确认 consent
  screen、品牌信息、允许域名和测试/发布状态。
- 微信只使用开放平台“网站应用”扫码登录，授权回调为
  `https://samepage.clyapps.com/api/auth/callback/wechat`，scope 必须是 `snsapi_login`；
  公众号网页授权不能替代该资质和配置。
- Client ID 与 Client Secret 都以 Worker Secret 管理。不得把 Secret 放入 `wrangler.jsonc`、
  `.dev.vars.example` 的实际值、GitHub Issue、PR 或发布日志。
- 部署代码、平台审核通过、生产 Secret 完整、真实账号授权成功是四个独立门槛。只有最后一项
  通过后，才能把对应提供方记为生产可用。

### 第三方登录故障排查

排查只记录提供方、时间、HTTP 状态和非敏感错误类别；不得复制授权 URL、callback query、
authorization code、token、完整 profile 或 Secret。

| 症状 | 检查 |
| --- | --- |
| Google 或微信图标未出现 | 请求 `/api/auth/social-providers`，确认响应仍为 `no-store`；用 `wrangler secret list` 只核对对应 Client ID / Secret 的名称是否成对存在，不读取或打印值。缺一项时隐藏入口是预期行为。 |
| Google 报 redirect URI 不匹配 | 核对 Web application client 的精确回调是 `https://samepage.clyapps.com/api/auth/callback/google`，协议、域名、路径和尾部斜杠必须一致。 |
| Google 只允许测试用户或显示 consent 错误 | 核对 consent screen 的测试/发布状态、测试用户、品牌域名和已验证域名；平台未发布不能记为生产可用。 |
| 微信提示 AppID、scope 或回调域错误 | 确认使用已审核的开放平台“网站应用”，scope 为 `snsapi_login`，AppID 属于该应用，授权回调域为 `samepage.clyapps.com`；公众号网页授权配置不能替代。 |
| 提供方确认后回到登录页并提示失败 | 先确认 `/api/health` 和邮箱登录正常，再按时间查 Worker 的非敏感状态日志；不要在日志或 Issue 中粘贴 callback URL。state 失效或重复回调应安全返回登录页，不能绕过重试。 |
| 中国大陆网络下 Google 超时 | 记录网络、设备和时间，将 Google 判为该场景不可用；确认邮箱入口始终可见可用。不要通过放宽 OAuth 校验或增加代理回调规避。 |

后续 `main` 发布必须先通过 CI 根据变更范围选择的门禁；无法识别范围时运行完整门禁，只有影响生产产物或 migration 的变更才进入 deploy job。正式发布或 migration 前，本地运行全量超集 `npm run check:full`；先运行 `npm ci` 和 `npx playwright install chromium webkit`（Linux/CI 使用 `--with-deps`）。`npm run check` 不包含 PWA 更新交接及加载性能，不能作为发布前的完整集合。
deploy job 在生产锁内核对发布顺序，记录发布尝试，在汇总 verify 通过后，下载 integration 封存的原始产物并校验完整清单，再执行 D1 恢复点记录、migrations、迁移后聚合/结构核查、Wrangler deploy 与线上机器验证。迁移或验证失败时 workflow 失败，不能记为发布成功。部署阶段不重新构建。

构建身份、HTML meta、Worker 须匹配显式 expected SHA；实际脚本逐个核对已验证发布包 `dist/client/build.json` 中的 SHA256（包括入口、共享与延迟加载脚本及 PDF Worker）。独立验收需下载对应 artifact；CLI 第三个参数可指定该清单路径，不能使用另一版本的本地构建。全部返回同一个旧版本仍失败。验收最多 12 次、每次请求超时 15 秒、间隔 3 秒，超过传播窗口则保留失败。成功记录只能在这些检查全部完成后写入。迁移后的失败尝试仍推进发布边界；旧作业不能在它之后部署旧 Worker。

## 每次发布记录

在对应 Issue 或 PR 中分别记录：

| 门槛 | 可接受证据 |
| --- | --- |
| 代码 | commit、PR、`npm run check:full` 结果（按范围 CI 的本地全量超集，不代表部署或实机验收） |
| CI | verify 与 deploy job 的 workflow URL 和结论、artifact ID/digest、release.json SHA 与文件摘要 |
| Cloudflare | Worker deployment ID、D1 migration 状态、R2 绑定 |
| 生产 URL | 显式 expected SHA；Worker、build.json、HTML 与脚本身份一致；HTTPS、manifest、Service Worker、未登录 401 |
| 第三方登录 | 提供方审核状态、回调配置、入口可见性、真实 Google/微信各一次成功与取消返回 |
| DNS | `samepage.clyapps.com` 的解析与证书；不得改动根域邮件记录 |
| 邮件 | QQ、163、Gmail、Outlook 各一次真实 OTP 到达与延迟；不记录 OTP |
| 人工验收 | iPad Safari、Android 平板、大陆真实网络的设备、浏览器版本与结论 |

## 人工验收脚本

每台目标设备至少完成一次：

1. 以未安装网页打开，登录并进入乐谱；再安装 PWA 重复核心路径。
2. 切换翻页与连续滚动，验证触摸/手写笔在阅读模式不产生批注。
3. 进入编辑后确认默认文本工具；验证文本、画笔、橡皮和完成编辑。
4. 下载离线副本，断网并重启；确认 PDF、共享层和个人层可用。
5. 离线编辑后恢复网络，手动同步并确认待上传数归零。
6. 制造同一对象冲突；确认冲突只在提交设备本地出现，云端仍只有规范版本。
7. 在存在待上传或冲突时退出；确认必须明确取消或丢弃。
8. 用户 A 的会话自然过期后继续离线编辑；以 A 重新登录，确认原草稿可同步且待上传数归零。
9. 用户 A 的会话自然过期后，在另一标签页以用户 B 登录并打开同一乐谱；确认所有旧标签页立即停止显示或提交 A 的个人层、草稿、冲突与权限缓存。
10. 分别验证访客进入注册用户、同一用户多标签页和主动退出后的路径；确认工作区不互相提升，主动退出后仅保留只读共享离线内容。
11. 在乐谱 A、B 分别离线编辑并退出阅读器；恢复网络或把应用切回前台，不重新打开 A、B，确认两份待上传内容都到达云端。随后让 A 暂时不可用并重复，确认 A 的原 `opId` 与 payload 留在本机、B 仍可完成同步，且没有自动 pull 未打开乐谱的新批注。
12. 发布新版本后保留旧页面，确认出现明确更新提示，用户确认后才刷新。
13. 在认证首屏确认邮箱表单仍在上方；分别完成 Google 与微信登录，并各取消一次；确认成功后续接原访客云盘流程，取消后邮箱草稿和原入口上下文仍保留。

14. 在公开体验中分别使用 Google、邮箱登录，确认无需加入即可在个人层新增、修改、删除批注，重新打开仍可读回；另一用户、管理员与访客均不可读取该个人层，共享层仍按授权编辑。
15. 管理员打开「管理 → 邀请码」查看当前码，关闭重开仍可查看；旧码仅有校验值时补录原码并确认原码继续有效，主动轮换后确认旧码失效。

真实 Safari、PWA 存储驱逐、手写笔和大陆网络表现不能由桌面自动化或 WebKit 模拟替代。

## 发布失败与显式回滚

Cloud Run 渲染器使用 Same Page 专属 GCP 项目和运行身份。一次性资源配置见
`renderer/provision.sh`；GitHub WIF 只允许本仓库 main 分支的 CI 工作流。
`PDF_RENDERER_SECRET` 分别保存于 GitHub Actions、Worker Secrets 和 Google Secret Manager；
Google 端固定使用 `same-page-renderer-signing:1`，轮换时应协调两个运行端及 CI 探针。
密钥只经标准输入或子进程环境传递，不写入仓库、命令参数或输出。

CI 在验证任务中构建、测试并保存 `renderer/image.tar`，随 release artifact 一起封存。
生产锁内先发布该镜像的不可变 digest，再验证 buildId、未签名请求 403、
签名测试 PDF 的六张完整 PNG 与 golden 文件逐字节一致，最后执行 D1 和 Worker 发布。
源配置中的 `PDF_RENDERER_URL` 是 Same Page 的稳定 Cloud Run 地址。

Cloud Run 和 Worker 发布不具备跨平台事务性；失败时分别核对 Run revision/buildId
与 Worker `/api/health`、`/build.json`，不能以任一端已成功代表完整发布。
恢复使用同一 release artifact 和串行 production admission，禁止重新构建后覆盖旧 SHA。
原 Durable Object 创建 migration 已在失败发布中上传，因此保留历史 tag，并添加删除类的 migration。
Cloudflare CI token 仍须具备 Queues Write 以管理现有 Queue consumer。

该服务采用公开 HTTPS 入口及应用签名鉴权；它不是 IAM 私有服务。
完整 PDF 只上传一次，所有 PNG 流式返回 Worker 并按原授权保存到私有 R2。
原生解析子进程无凭据，Linux seccomp 禁止网络和跨进程读取。
成本配置为 1 vCPU / 1 GiB / min 0 / max 1 / concurrency 1；免费额度按结算账号共享，
互联网出网、镜像存储及日志单独计量，参见 `cloud-run-evaluation.md`。

1. 先在 Actions 确定失败阶段。准入跳过表示已有更新的发布尝试；历史不可达、分叉、GitHub 记录不可用或 artifact 校验失败都在生产写入前停止。不要通过删除发布记录或修改 expected SHA 绕过。
2. 下载失败或 artifact 过期：重跑包含 integration、verify 和 deploy 的完整工作流。相同 SHA 允许重试；不允许在部署阶段临时构建一份新产物。`npm run deploy` 仅供已获授权的手工恢复，要求 `SAME_PAGE_RELEASE_SHA` 与已校验的 release.json 一致，不构建、不迁移，也不替代完整发布流程；执行时须停止并发 CI 发布并单独记录。
3. 迁移失败：使用本次步骤记录的 D1 Time Travel 恢复点和迁移前聚合结果，先确定哪些迁移已应用。保留非取消的部署锁，不要在迁移过程中启动另一次写入。修复幂等迁移后重试同 SHA 或发布后继修复。
4. Worker/静态资源上传或线上身份验收失败：检查 expected SHA、上传 artifact、线上 health/build.json/HTML/脚本各自版本与 Actions 原始错误。传播超时不能写成功；可重试同 SHA 的 deploy，仍须重新执行恢复点和迁移核查。
5. 代码回滚采用新的 `git revert` 提交，经过完整验证和同一发布链路向前发布，使发布顺序仍单调。先核对回滚代码与当前 schema 是否兼容；迁移不兼容时先设计明确的数据恢复/前向修复，不能直接用旧 Worker 覆盖新 schema。恢复 D1 是单独、明确授权的生产操作，应说明可能丢失恢复点之后的数据并核查 R2 一致性；本工作流不会自动恢复数据库。
6. GitHub 发布记录缺失或历史分叉时，先重建可信版本证据并恢复正常 main 历史；正常发布不提供强制忽略开关。首次启用记录时只读核对线上 Worker SHA，必须能在完整 Git 历史中解析。

默认通过 CI 发布。手工恢复完成后须记录源码、artifact、D1、Worker deployment ID 和独立线上验收；恢复点、流水线通过、外部身份提供方成功和实机验收各自独立。
