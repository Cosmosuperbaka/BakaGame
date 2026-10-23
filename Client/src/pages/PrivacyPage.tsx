import { Seo } from "@/components/common/Seo";
import { LegalPage } from "@/components/common/LegalPage";
import { PRIVACY_UPDATED_AT, PrivacyBody } from "@/components/legal/PrivacyBody";

/**
 * 隐私说明的整页路由（`/privacy`）。
 *
 * 正文不在这里：它与「关于项目」页的隐私标签共用 `PrivacyBody` 一份内容，
 * 两处各写一遍迟早会漂成两个版本，而这两份文本必须一致。
 */
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
        updatedAt={PRIVACY_UPDATED_AT}
        related={{ href: "/terms", label: "用户条款" }}
      >
        <PrivacyBody />
      </LegalPage>
    </>
  );
}
