import type { ReactNode } from "react";
import { Seo } from "@/components/common/Seo";
import { LegalPage, LegalSection } from "@/components/common/LegalPage";

/** 一条信息项：来源与用途分开写，便于读者逐项核对。 */
function DataItem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm font-semibold">{title}</dt>
      <dd className="mt-1 space-y-1 text-sm leading-6 text-muted-foreground">{children}</dd>
    </div>
  );
}

export default function PrivacyPage() {
  return (
    <>
      <Seo
        path="/privacy"
        description="BakaGame 隐私说明：逐项列出我们收集的信息、信息来源与用途，涉及 QQ 登录、对局记录、访问日志、Cookie、错误监控与第三方服务。"
        indexable={false}
      />
      <LegalPage
        title="隐私说明"
        updatedAt="2026-10-21"
        related={{ href: "/terms", label: "用户条款" }}
      >
        <p className="text-sm leading-6 text-muted-foreground">
          本页说明 BakaGame（下称「本站」）会收集哪些信息、信息从哪里来、用来做什么，以及你如何联系我们处理相关信息。本站不要求注册即可游玩，游客状态下的信息收集范围更小。
        </p>

        <LegalSection title="一、我们收集的信息">
          <dl className="space-y-4">
            <DataItem title="QQ 号、QQ 昵称与 QQ 头像">
              <p>
                <span className="text-foreground">来源：</span>
                你使用账号功能时主动输入的 QQ 邮箱；昵称由运营方自建的 QQ 昵称服务读取；头像经站内代理从 QQ 头像源获取。
              </p>
              <p>
                <span className="text-foreground">用途：</span>
                创建与识别账号、展示昵称与头像、账号安全与找回。QQ 号默认不公开，只有你本人在资料设置中开启后，其他玩家才能通过资料卡看到。
              </p>
            </DataItem>

            <DataItem title="对局记录">
              <p>
                <span className="text-foreground">来源：</span>
                你在房间内的结算结果与关键对局事件。
              </p>
              <p>
                <span className="text-foreground">用途：</span>
                后台复盘、对局统计、反作弊与问题排查。对局记录长期保留，不包含房间聊天内容。
              </p>
            </DataItem>

            <DataItem title="访问日志与 IP 地址">
              <p>
                <span className="text-foreground">来源：</span>
                你访问本站时产生的网络请求，包括边缘节点写入的客户端地址。
              </p>
              <p>
                <span className="text-foreground">用途：</span>
                安全审计、访问限流、故障排查与服务稳定性维护。服务端运行日志按运维需要保留有限期限；管理后台的审计记录不保存 IP 地址。
              </p>
            </DataItem>

            <DataItem title="Cookie 与浏览器本地存储">
              <p>
                <span className="text-foreground">来源：</span>
                你使用本站时由浏览器自动保存。
              </p>
              <p>
                <span className="text-foreground">用途：</span>
                会话 Cookie 用于保持登录状态与完成通行密钥等安全校验；本地存储用于记住房间设置、音量与界面偏好、客户端更新提示，以及一个随机生成的匿名访客标识。
              </p>
              <p>
                <span className="text-foreground">说明：</span>
                访问统计使用本机随机生成的访客标识，服务端按天加盐摘要后才会写入数据库，跨天不可关联，且不记录 IP。
              </p>
            </DataItem>

            <DataItem title="错误与性能数据（Sentry）">
              <p>
                <span className="text-foreground">来源：</span>
                客户端与服务端运行时自动采集，经站内隧道转发至 Sentry。
              </p>
              <p>
                <span className="text-foreground">用途：</span>
                定位崩溃、接口异常与性能问题，改进服务稳定性。数据可能包含错误堆栈、页面路径、浏览器与设备类型、客户端版本与构建版本。
              </p>
            </DataItem>

            <DataItem title="音乐平台账号凭据（仅在你主动配置时）">
              <p>
                <span className="text-foreground">来源：</span>
                你主动填写或扫码登录产生的网易云音乐、QQ 音乐凭据。
              </p>
              <p>
                <span className="text-foreground">用途：</span>
                以你的身份向对应平台请求歌曲信息与播放地址，并支持账号设置的云端同步。凭据在服务端加密后保存，只有你本人能读写自己的设置；退出平台时删除云端副本。
              </p>
            </DataItem>

            <DataItem title="房间聊天消息">
              <p>
                <span className="text-foreground">来源：</span>
                你在房间内发送的聊天内容。
              </p>
              <p>
                <span className="text-foreground">用途：</span>
                实时展示给房间内玩家；服务重启时随房间状态快照恢复仍在进行的房间。
              </p>
              <p>
                <span className="text-foreground">说明：</span>
                聊天消息不写入对局记录，房间结束后不再保留。
              </p>
            </DataItem>
          </dl>
        </LegalSection>

        <LegalSection title="二、第三方服务">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="font-semibold">Bangumi：</span>
              提供番剧、角色与相关资料的检索与展示。请求只携带必要的检索参数，不包含你的账号凭据。
            </li>
            <li>
              <span className="font-semibold">网易云音乐、QQ 音乐：</span>
              提供歌曲搜索、试听与账号相关能力。当你使用对应功能时，请求会发往相应平台，并受该平台隐私政策约束。
            </li>
            <li>
              <span className="font-semibold">Sentry：</span>
              接收经站内隧道转发的错误与性能数据，用于监控与故障排查。
            </li>
            <li>
              <span className="font-semibold">QQ 昵称服务：</span>
              由运营方自建，仅用于读取 QQ 昵称；不向站外第三方共享这些数据。
            </li>
          </ul>
          <p>
            除上述服务与法律法规要求外，本站不出售、不出租、不向无关第三方提供你的个人信息。
          </p>
        </LegalSection>

        <LegalSection title="三、信息的存储与安全">
          <ul className="list-disc space-y-2 pl-5">
            <li>账号数据存储于运营方控制的数据库，仅授予必要的运维与管理人员访问权限。</li>
            <li>音乐平台凭据加密保存；会话 Cookie 在生产环境启用 Secure 等安全属性。</li>
            <li>
              互联网传输与存储不存在绝对安全。本站会按合理标准保护信息，但无法承诺信息绝不泄露。
            </li>
          </ul>
        </LegalSection>

        <LegalSection title="四、你的权利">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              你可以通过站内反馈或页脚列出的社区入口联系我们，查询、更正或删除与你账号相关的信息；法律法规要求保留的记录除外。
            </li>
            <li>
              你可以随时退出登录。清除浏览器本地存储会删除本机偏好与匿名访客标识，同时也可能失去房间设置记忆。
            </li>
          </ul>
        </LegalSection>

        <LegalSection title="五、未成年人">
          <p>
            本站面向一般用户。未成年人应在监护人同意与指导下使用本站；如监护人发现未成年人未经同意提交了个人信息，可联系我们处理。
          </p>
        </LegalSection>

        <LegalSection title="六、本说明的更新">
          <p>
            本说明更新后会在此页公布并更新「最后更新」日期；涉及权利范围的重大变化会在站内显著位置提示。
          </p>
        </LegalSection>

        <LegalSection title="七、联系我们">
          <p>
            登录后可通过页脚的站内反馈联系我们，也可以通过页脚列出的社区入口找到运营者。
          </p>
        </LegalSection>
      </LegalPage>
    </>
  );
}
