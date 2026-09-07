import { BackButton } from "../navigation/back-button";
import { Link } from "react-router-dom";

import { AppHeader } from "../components/app-header";

const CONTACT_EMAIL = "admin@clyapps.com";

export default function PrivacyPage() {
  return (
    <div className="privacy-page">
      <AppHeader />
      <main className="privacy-document" aria-labelledby="privacy-title">
        <header className="privacy-document__header">
          <p className="eyebrow">合谱 · Same Page</p>
          <h1 id="privacy-title">隐私政策</h1>
          <p className="privacy-document__updated">最后更新：2026 年 9 月 6 日</p>
          <p className="privacy-document__lead">
            合谱（Same Page）是为合唱排练设计的乐谱云盘。本政策说明我们在你使用服务时处理哪些信息、为什么处理，以及你可以如何联系我们。
          </p>
        </header>

        <section aria-labelledby="privacy-collect">
          <h2 id="privacy-collect">我们处理的信息</h2>
          <ul>
            <li>
              <strong>用户与登录信息：</strong>
              邮箱地址、邮箱验证状态、加密或散列后的登录凭据、第三方登录提供方返回的稳定认证身份标识，以及用于保护会话的 IP 地址和浏览器信息。
            </li>
            <li>
              <strong>Google 或微信登录信息：</strong>
              当你主动选择第三方登录时，我们会接收完成登录所需的基础身份资料，例如经过验证的邮箱、昵称或头像。微信未返回邮箱时，我们只会生成不可投递的内部标识，不会将其用于联系你。
            </li>
            <li>
              <strong>云盘内容：</strong>
              你所在的云盘、云盘内显示名和权限，上传的 PDF 乐谱及文件名，以及个人层和共享层中的批注、偏好与同步状态。
            </li>
            <li>
              <strong>设备本地数据：</strong>
              为支持离线使用，浏览器可能在当前设备保存乐谱、批注、偏好和待同步操作。访客访问记录和离线副本也可能保存在当前设备。
            </li>
          </ul>
        </section>

        <section aria-labelledby="privacy-use">
          <h2 id="privacy-use">我们如何使用这些信息</h2>
          <ul>
            <li>创建和保护用户，完成登录、邮箱验证与密码重置；</li>
            <li>判断你对云盘、乐谱和批注层的访问与编辑权限；</li>
            <li>存储、同步并在你的设备上离线提供乐谱和批注；</li>
            <li>发送必要的登录安全邮件；</li>
            <li>防止滥用、排查故障并维护服务安全与可靠性。</li>
          </ul>
          <p>
            我们不出售你的个人信息，不使用这些信息投放定向广告。个人层批注默认仅自己可见。
          </p>
        </section>

        <section aria-labelledby="privacy-sharing">
          <h2 id="privacy-sharing">云盘内的可见范围</h2>
          <p>
            个人层默认仅自己可见。共享层和乐谱属于对应云盘，具有访问权的成员或访客可以查看；获得相应编辑权的成员可以修改。共享批注可能保留创建者或最后修改者的云盘内显示名。成员名单只向云盘拥有者、受托权限管理者及有成员移除权限的成员开放，具体信息以其授权范围为准。
          </p>
          <p>
            第三方登录资料不会自动成为你在所有云盘中的公开身份；你可以在不同云盘使用不同的显示名。
          </p>
        </section>

        <section aria-labelledby="privacy-processors">
          <h2 id="privacy-processors">服务提供方</h2>
          <p>我们只在提供和保护 Same Page 所需的范围内使用以下服务：</p>
          <ul>
            <li>
              <strong>Cloudflare：</strong>
              提供网络、安全、应用运行、数据库和 PDF 文件存储服务；
            </li>
            <li>
              <strong>Resend：</strong>
              发送注册验证、密码重置等必要的登录安全邮件；
            </li>
            <li>
              <strong>Google 或微信：</strong>
              仅在你选择相应方式时完成身份验证。
            </li>
          </ul>
          <p>
            这些服务提供方会依据各自的条款和隐私政策处理信息。法律要求、保护用户与服务安全，或完成组织重组所必需时，我们也可能依法披露相关信息。
          </p>
        </section>

        <section aria-labelledby="privacy-google">
          <h2 id="privacy-google">Google 用户数据</h2>
          <p>
            Same Page 的 Google 登录只使用建立和登录用户所需的基础身份信息，不申请 Google Drive、通讯录、Gmail 或其他额外数据权限。Google 数据仅用于身份验证、登录安全和向你提供 Same Page，不用于广告。
          </p>
          <p>
            我们对 Google 用户数据的使用遵守
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              rel="noreferrer"
              target="_blank"
            >
              Google API 服务用户数据政策
            </a>
            ，包括其中的 Limited Use 要求。
          </p>
        </section>

        <section aria-labelledby="privacy-retention">
          <h2 id="privacy-retention">保留、删除与离线副本</h2>
          <ul>
            <li>在你使用服务期间，我们会保留提供服务所需的用户和云盘数据。</li>
            <li>
              普通云盘的成员退出或被移除后，该成员关系授予的云端访问与同步立即撤销，个人层保留 30 天，期间可由有成员恢复权限的人恢复。个人层默认仅自己可见。公开体验中，本人个人层的访问与保留不依赖成员关系。
            </li>
            <li>
              你可以在“个人设置”进入对应云盘完成拥有权转让、重新验证原登录方式并确认删除。删除会立即撤销产品会话与云端访问；身份数据和个人层进入 30 天恢复期。期间使用删除时的登录方式验证后，只能明确确认恢复，不能直接访问云盘。恢复期结束后定时任务清理身份与个人层。共享批注继续保留最终云盘内显示名，不以登录邮箱或全局资料名作为署名。
            </li>
            <li>
              待确认的候选 PDF 在 24 小时后到期；旧 PDF 离开当前版本后保留 30 天供回滚，移入回收站的乐谱及其版本从移入时起保留 30 天。到期内容由定时任务回收，失败时重试，物理删除可能晚于到期时刻。
            </li>
          </ul>
          <p>
            已下载到设备的内容无法远程收回。删除用户会断开本机身份，未同步草稿继续保留在原用户下，其他用户不能读取；删除恢复期结束后服务端无法恢复已清理的数据。明确退出登录时，Same Page 会清除当前浏览器中的个人层、可编辑状态和用户偏好；已同步并去除个人身份的共享内容可能继续保留以供离线查看。你也可以通过浏览器或操作系统清除站点数据。
          </p>
        </section>

        <section aria-labelledby="privacy-security">
          <h2 id="privacy-security">安全措施</h2>
          <p>
            我们使用传输加密、服务端权限检查、登录限流和凭据保护等措施。OAuth 访问令牌和刷新令牌会加密保存，完成 Google 身份验证后不持久化 Google ID token。任何网络服务都无法保证绝对安全；如你发现安全问题，请尽快联系我们。
          </p>
        </section>

        <section aria-labelledby="privacy-diagnostics">
          <h2 id="privacy-diagnostics">故障诊断</h2>
          <p>客户端只在当前页面会话内保留最近 30 分钟、最多 50 条错误记录，刷新或切换身份即清空。你可以在<Link to="/diagnostics">故障诊断</Link>页面或阅读器诊断面板查看、复制、清空或主动发送诊断；未点击发送时不会上传。待发报告与选填描述只保留在当前会话，刷新、关闭网页或切换身份后清空。</p>
          <p>主动发送的诊断包含错误编号、时间、次数、版本、操作类别、阶段及可重试性，以及浏览器与系统版本、窗口尺寸、网络提示、PWA 状态；从阅读器发送时还包含谱面显示方式、阅读或编辑状态、待同步与冲突数量。系统不会自动收集乐谱或批注正文、截图、文件名、邮箱、原始 IP、凭据、完整网址或原始异常。你填写的问题描述会随报告发送，请勿包含私人内容、密码、验证码或邀请码。</p>
          <p>报告通过合谱服务保存于 Cloudflare D1，仅获授权的维护人员可查看和标记处理状态；反馈编号不授予读取权限，云盘管理权限不授予访问报告的能力。报告保留 30 天，到期后不再通过收件箱提供访问，并由每小时任务删除；清空本机诊断不会撤回已发送报告。报告不与用户、云盘或乐谱建立关联，不自动发布到 GitHub 或发送给第三方支持平台。</p>
          <p>接口使用短期限流标识防止滥用，不保存原始 IP 或登录凭据到报告。服务端结构化运行日志仍按 Cloudflare 套餐保留 3 或 7 天，不写入报告描述。基础设施提供方自身的数据处理（包括备份与安全日志）另受其政策约束。</p>
        </section>

        <section aria-labelledby="privacy-rights">
          <h2 id="privacy-rights">你的选择与联系我们</h2>
          <p>
            你可以选择不使用 Google 或微信登录，继续使用邮箱登录。若要查询、更正或删除用户信息，撤回第三方登录授权，或咨询本政策，请发送邮件至
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>。撤回第三方授权不会自动删除 Same Page 中已建立的用户或依法需要保留的数据。
          </p>
        </section>

        <section aria-labelledby="privacy-updates">
          <h2 id="privacy-updates">政策更新</h2>
          <p>
            服务或数据处理方式发生重要变化时，我们会更新本页面和顶部日期；必要时也会通过服务内提示或邮件说明。
          </p>
        </section>

        <BackButton className="privacy-document__home" to="/drives">
          返回合谱首页
        </BackButton>
      </main>
    </div>
  );
}
