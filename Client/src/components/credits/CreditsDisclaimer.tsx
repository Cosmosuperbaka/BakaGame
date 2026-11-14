import { FeedbackButton } from "@/components/account/AccountEntry";

/**
 * 非官方声明：紧跟特别鸣谢，上面列的正是本站在用、却没有隶属关系的来源。
 * 反馈入口就放在声明里，想举报侵权或违规内容的人不用再去别处找。
 */
export function CreditsDisclaimer() {
  return (
    <section aria-labelledby="credits-disclaimer-heading">
      <h2 id="credits-disclaimer-heading" className="text-base font-semibold">
        声明
      </h2>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        BakaGame
        是爱好者自制的作品，与游戏里涉及的动画、音乐等作品的版权方，以及上面列出的资料来源、网易云音乐和
        QQ
        音乐等第三方服务都没有官方关系。发现侵权或违规内容，或者遇到别的问题，可以通过反馈告诉我们。
      </p>
      <div className="mt-2">
        <FeedbackButton />
      </div>
    </section>
  );
}
