import { TriangleAlert } from "lucide-react";
import { Seo } from "@/components/common/Seo";
import { LegalPage, LegalSection } from "@/components/common/LegalPage";

export default function TermsPage() {
  return (
    <>
      <Seo
        path="/terms"
        description="BakaGame 用户条款：服务说明、第三方音乐平台账号风险、使用规范、服务变更与中断、免责与责任限制、适用法律与管辖。"
        indexable={false}
      />
      <LegalPage
        title="用户条款"
        updatedAt="2026-10-21"
        related={{ href: "/privacy", label: "隐私说明" }}
      >
        <p className="text-sm leading-6 text-muted-foreground">
          欢迎使用 BakaGame（下称「本站」）。使用本站即表示你已阅读并同意本条款；若你不同意，请停止使用。
        </p>

        <section
          aria-labelledby="terms-music-risk"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-4"
        >
          <h2
            id="terms-music-risk"
            className="flex items-center gap-2 text-sm font-semibold text-foreground"
          >
            <TriangleAlert aria-hidden="true" className="text-destructive" />
            重要风险提示
          </h2>
          <p className="mt-2 text-sm leading-6">
            SongGuessr 会调用网易云音乐、QQ
            音乐等第三方音乐平台的接口与账号能力。使用相关功能可能导致你的音乐平台账号被平台封禁、限流、扣费或采取其它处置。由此产生的风险与后果由你自行承担，本站不承担责任。请确认你已了解并接受该风险后再使用对应功能。
          </p>
        </section>

        <LegalSection title="一、服务说明">
          <ul className="list-disc space-y-2 pl-5">
            <li>本站提供 Who is Faker、SongGuessr、CEE 等在线小游戏，按现状免费提供。</li>
            <li>
              本站与网易云音乐、QQ
              音乐、Bangumi 等第三方平台没有隶属或代理关系，相关内容与服务的可用性由对应平台决定。
            </li>
            <li>本站可以随时调整玩法、功能与开放范围，无需事先通知。</li>
          </ul>
        </LegalSection>

        <LegalSection title="二、账号与第三方凭据">
          <ul className="list-disc space-y-2 pl-5">
            <li>游客可直接游玩；账号功能以 QQ 号为身份锚点，账号昵称取自 QQ 昵称。</li>
            <li>
              你在站内配置的音乐平台账号、Cookie、令牌等凭据由你自愿提供，仅用于你请求的功能。请确保你有权使用该账号，不要提交他人的凭据。
            </li>
            <li>
              因凭据失效、平台风控、账号被处置，或你违反平台规则造成的损失，由你自行承担。
            </li>
          </ul>
        </LegalSection>

        <LegalSection title="三、使用规范">
          <p>使用本站时，你不得：</p>
          <ul className="list-disc space-y-2 pl-5">
            <li>上传、传播侵权、盗版或违法内容；</li>
            <li>刷量、批量注册、自动化滥用、攻击、扫描或探测本站，或绕过限流与访问控制；</li>
            <li>冒充他人，骚扰、辱骂或发布恶意内容；</li>
            <li>干扰其他玩家正常游玩，或破坏服务稳定。</li>
          </ul>
          <p>
            出现上述行为时，本站可以限制功能、封禁账号或删除相关内容，并保留追究责任的权利。
          </p>
        </LegalSection>

        <LegalSection title="四、用户内容">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              你在聊天、昵称与房间设置中产生的内容由你自行负责；你应确保拥有发布这些内容的权利。
            </li>
            <li>本站可以在合理范围内处理违规内容；房间内的聊天仅用于对局交流。</li>
          </ul>
        </LegalSection>

        <LegalSection title="五、服务变更、中断与终止">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              本站不承诺服务可用性（SLA），可能因维护、升级、故障、网络问题或不可抗力中断或终止。
            </li>
            <li>本站不承诺数据永久保留；请自行保存需要留存的信息。</li>
          </ul>
        </LegalSection>

        <LegalSection title="六、免责与责任限制">
          <ul className="list-disc space-y-2 pl-5">
            <li>
              在适用法律允许的范围内，本站不对因使用或无法使用本站造成的间接损失、数据丢失或第三方平台处置承担责任。
            </li>
            <li>第三方平台的服务、内容与规则由其自行负责，本站不对其行为作出担保。</li>
          </ul>
        </LegalSection>

        <LegalSection title="七、条款更新">
          <p>
            本条款更新后会在此页公布并更新「最后更新」日期；你继续使用本站，视为接受更新后的条款。
          </p>
        </LegalSection>

        <LegalSection title="八、法律适用与管辖">
          <ul className="list-disc space-y-2 pl-5">
            <li>本条款适用中华人民共和国法律。</li>
            <li>
              因本条款或使用本站产生的争议，由运营方所在地有管辖权的人民法院管辖。
            </li>
          </ul>
        </LegalSection>

        <LegalSection title="九、联系我们">
          <p>登录后可通过页面右上角的站内反馈联系我们，也可以通过页脚列出的社区入口找到运营者。</p>
        </LegalSection>
      </LegalPage>
    </>
  );
}
