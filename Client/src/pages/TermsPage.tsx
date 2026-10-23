import { Seo } from "@/components/common/Seo";
import { LegalPage } from "@/components/common/LegalPage";
import { TERMS_UPDATED_AT, TermsBody } from "@/components/legal/TermsBody";

/**
 * 用户条款的整页路由（`/terms`）。
 *
 * 正文与「关于项目」页的条款标签共用 `TermsBody` 一份内容，不各写一遍。
 */
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
        updatedAt={TERMS_UPDATED_AT}
        related={{ href: "/privacy", label: "隐私说明" }}
      >
        <TermsBody />
      </LegalPage>
    </>
  );
}
