import { useState } from "react";
import { motion } from "framer-motion";
import { listItem, listContainer } from "@/lib/motion/Choreography";
import { iconTappable, pressable } from "@/lib/motion/Feedback";
import { usePageLinkClick, useSharedElementName } from "@/hooks/UsePageTransition";
import { Activity, ArrowUpRight } from "lucide-react";
import { BrandIcon } from "@/components/common/BrandIcon";
import type { BrandIconName } from "@/data/BrandIconPaths";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Seo } from "@/components/common/Seo";
import { SiteAgentPresence } from "@/components/common/SiteAgentPresence";
import { AccountButton, AccountDialogs, FeedbackButton } from "@/components/account/AccountEntry";
import { ClientUpdateNotice } from "@/components/ClientUpdateNotice";
import { SettingsEntry } from "@/components/settings/SettingsEntry";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/Tooltip";
import { ClientDownloadEntry } from "@/components/ClientDownloadEntry";
// 展示版本号构建期从 changelog.json 解析（与致谢页同一真相源），整份日志不随首屏下载。
import appVersion from "virtual:app-version";
import { currentCommit } from "virtual:build-info";
import { REPOSITORY_URL, findPageMeta } from "@/data/PageMeta";
import { GAME_ROUTES } from "@bakagame/shared/values";
import { useSiteFeatures, type SiteFeatures } from "@/lib/SiteConfig";
import { cn } from "@/lib/Utils";
import { aboutsTabHref } from "@/lib/AboutsTabs";

interface GameSubMode {
  id: string;
  title: string;
  path?: string;
  available: boolean;
  /**
   * 挂在服务端开关上的入口：后台临时关掉后**留在原位、置灰、标注「暂时关闭」、点不进去**。
   * 与 `available: false`（还没上线）同一种不可用态，区别只在徽章文案与原因。
   */
  feature?: keyof SiteFeatures;
}

interface GameEntry {
  id: string;
  path?: string;
  /** 该游戏大厅的路径：卡片标题与大厅顶栏的游戏名是同一个跨页共享元素；未上线的游戏省略 */
  lobbyPath?: string;
  icon: string;
  /** 条目主标题 */
  title: string;
  /** 卡片标题下的一行简介：取自该游戏 PageMeta 的 oneLiner，与分享卡片、静态外壳说同一件事 */
  intro?: string;
  available: boolean;
  /** 单一入口游戏挂的服务端开关，语义同子模式的 `feature`。 */
  feature?: keyof SiteFeatures;
  subModes?: GameSubMode[];
}

const GAMES: GameEntry[] = [
  {
    id: "whoisfaker",
    path: GAME_ROUTES.faker.base,
    lobbyPath: GAME_ROUTES.faker.base,
    icon: "/assets/Faker.png",
    title: "Who is Faker",
    intro: findPageMeta(GAME_ROUTES.faker.base)?.oneLiner,
    available: true,
    feature: "fakerEntry",
  },
  {
    id: "songuessr",
    lobbyPath: GAME_ROUTES.song.base,
    icon: "/assets/SongGuessr.gif",
    title: "Songuessr",
    intro: findPageMeta(GAME_ROUTES.song.base)?.oneLiner,
    available: true,
    subModes: [
      {
        id: "singleplayer",
        title: "单人模式",
        path: `${GAME_ROUTES.song.base}/solo`,
        available: true,
        feature: "songSoloEntry",
      },
      {
        id: "multiplayer",
        title: "多人模式",
        path: GAME_ROUTES.song.base,
        available: true,
        feature: "songMultiplayerEntry",
      },
    ],
  },
  {
    id: "animecharguessr",
    path: GAME_ROUTES.cee.base,
    lobbyPath: GAME_ROUTES.cee.base,
    icon: "/assets/CEE.jpg",
    // 正式名是 CEE，原版名放进简介：页面标题、大厅与搜索结果里是同一个名字。
    title: "CEE",
    intro: findPageMeta(GAME_ROUTES.cee.base)?.oneLiner,
    available: true,
    subModes: [
      {
        id: "multiplayer",
        title: "多人模式",
        path: GAME_ROUTES.cee.base,
        available: true,
        feature: "ceeMultiplayerEntry",
      },
      {
        id: "ranked",
        title: "排位赛",
        path: `${GAME_ROUTES.cee.base}/ranked`,
        available: true,
        feature: "ceeRankedEntry",
      },
      {
        id: "tournament",
        title: "锦标赛",
        available: false,
      },
    ],
  },
];

interface FriendLink {
  href: string;
  name: string;
}

const FRIEND_LINKS: FriendLink[] = [
  { href: "https://ccb.baka.website/", name: "二刺猿笑传之猜猜呗" },
  { href: "https://anipeek.animaster.dpdns.org/", name: "动漫高手一眼顶针" },
  { href: "https://decrypto.monight.dpdns.org/", name: "动漫高手截码战" },
];

interface ExternalLink {
  href: string;
  label: string;
  icon: BrandIconName;
}

const EXTERNAL_LINKS: ExternalLink[] = [
  { href: "https://qm.qq.com/q/yIoCHg85iK", label: "加入 QQ 群", icon: "qq" },
  { href: REPOSITORY_URL, label: "GitHub 仓库", icon: "github" },
  { href: "https://space.bilibili.com/354780713", label: "作者哔哩哔哩主页", icon: "bilibili" },
];

const STATUS_PAGE_PATH = "/status";

function ComingSoonBadge() {
  return (
    <Badge variant="upcoming" size="xs" className="shrink-0 select-none">
      即将上线
    </Badge>
  );
}

/** 后台临时关掉的入口：与「即将上线」同为不可用态，但原因不同，不能共用一句「即将上线」。 */
function ClosedBadge() {
  return (
    <Badge variant="upcoming" size="xs" className="shrink-0 select-none">
      暂时关闭
    </Badge>
  );
}

/** 不可用入口的占位格：虚线、降色、不可点，尺寸与可点的按钮一致，关掉入口不让卡片跳动。 */
const closedSlotClass =
  "flex h-8 items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-muted/40 px-1.5 text-center text-xs text-muted-foreground select-none";

/** 卡片头部的图标、标题与副标题。标题与大厅顶栏的游戏名是同一个跨页共享元素，只在两页互相过渡时命名。 */
function GameIdentity({ game }: { game: GameEntry }) {
  const sharedName = useSharedElementName("game-title", game.lobbyPath ?? false);
  return (
    <div className="flex items-center gap-2.5 min-w-0 flex-1">
      <img
        src={game.icon}
        alt=""
        aria-hidden="true"
        className="h-10 w-10 shrink-0 rounded-md object-cover border border-border [@media(max-height:680px)]:h-8 [@media(max-height:680px)]:w-8"
      />
      <div className="min-w-0 flex-1">
        {/* 宽度贴合文字：快照只含字形，移到大厅顶栏时不带着整行留白一起缩放 */}
        <div
          className="w-fit max-w-full text-sm sm:text-base font-serif font-semibold truncate whitespace-nowrap"
          style={{ viewTransitionName: sharedName }}
        >
          {game.title}
        </div>
        {game.intro ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{game.intro}</p>
        ) : null}
      </div>
    </div>
  );
}

function GameRow({ game, features }: { game: GameEntry; features: SiteFeatures }) {
  const linkClick = usePageLinkClick();
  // 只用来挡住重复点击：分块还在加载时旧页仍可点，第二次点击会往历史里再压一条同样的记录。
  const [enteringPath, setEnteringPath] = useState<string | null>(null);

  // 入口是真链接（抓取器、中键与新标签页拿得到地址）；普通左键立即导航：
  // 旧页连同按下的入口一起定格成过渡快照向前退出，离开当前页读作这次点击的结果。
  const handleEnter = (targetPath: string) =>
    linkClick(targetPath, () => {
      if (enteringPath) return false;
      setEnteringPath(targetPath);
      return undefined;
    });

  // 单一入口游戏被后台临时关掉：卡片照常呈现，入口按钮换成「暂时关闭」的占位格。
  const isGameClosed = game.available && Boolean(game.feature && !features[game.feature]);

  // 卡片容器本身不可点（入口是里面的按钮），悬停描边只留给可用的卡片，读作「这一张能进」；未上线或暂时关闭的卡片不响应悬停。
  const cardContainerClass = cn(
    "flex h-full min-h-0 w-full flex-col justify-between gap-2.5 sm:gap-3 overflow-hidden rounded-md border bg-card p-3 sm:p-3.5 text-left shadow-2xs transition-colors [@media(max-height:680px)]:gap-1.5 [@media(max-height:680px)]:p-2",
    game.available && !isGameClosed && "hover:border-primary/40"
  );

  // 单一入口游戏（如 Who is Faker）
  if (!game.subModes) {
    if (!game.available) {
      return (
        <motion.div data-testid={`game-entry-${game.id}`} variants={listItem} className="h-full">
          <div aria-disabled="true" className={cardContainerClass}>
            <div className="flex w-full items-center justify-between gap-2">
              <GameIdentity game={game} />
              <ComingSoonBadge />
            </div>
          </div>
        </motion.div>
      );
    }

    return (
      <motion.div data-testid={`game-entry-${game.id}`} variants={listItem} className="h-full">
        <div className={cardContainerClass}>
          <div className="flex w-full items-center justify-between gap-2">
            <GameIdentity game={game} />
          </div>

          <div className="w-full">
            {isGameClosed ? (
              <div aria-disabled="true" className={closedSlotClass}>
                <span className="truncate">开始游戏</span>
                <ClosedBadge />
              </div>
            ) : (
              <Button
                asChild
                variant="outline"
                size="sm"
                className="h-8 w-full text-xs sm:text-sm font-medium"
              >
                <motion.a
                  href={game.path}
                  aria-label={`${game.title} 开始游戏`}
                  data-agent-control={`site.game.${game.id}`}
                  onClick={game.path ? handleEnter(game.path) : undefined}
                  {...pressable}
                >
                  开始游戏
                </motion.a>
              </Button>
            )}
          </div>
        </div>
      </motion.div>
    );
  }

  // 包含子模式入口的游戏（如 Songuessr 与 CEE）
  const isWholeGameDisabled = !game.available;
  const subModeCount = game.subModes.length;

  return (
    <motion.div data-testid={`game-entry-${game.id}`} variants={listItem} className="h-full">
      <div aria-disabled={isWholeGameDisabled ? "true" : undefined} className={cardContainerClass}>
        {/* 卡片头部：图标、标题与主状态 */}
        <div className="flex w-full items-center justify-between gap-2">
          <GameIdentity game={game} />
          {isWholeGameDisabled && <ComingSoonBadge />}
        </div>

        {/* 子模式按钮行 */}
        <div
          className={`grid w-full gap-2 ${
            game.subModes.length === 2 ? "grid-cols-2" : "grid-cols-2 gap-1.5 sm:grid-cols-3"
          }`}
        >
          {game.subModes.map((mode, index) => {
            // 受控子模式被后台关掉时**不隐藏**：格子留着、置灰、标注「暂时关闭」，
            // 让玩家看得出这个玩法存在但暂时不可进，而不是以为站点少了点什么。
            const isAllowed = !mode.feature || features[mode.feature];
            const isModeAvailable = !isWholeGameDisabled && mode.available && isAllowed;
            const isModeClosed = !isWholeGameDisabled && mode.available && !isAllowed;
            // 三个子模式在窄屏排成两行，首项独占一行：三等分时每格不到 110px，放不下模式名加「即将上线」。
            const spanClass = subModeCount === 3 && index === 0 ? "max-sm:col-span-2" : "";

            if (!isModeAvailable || !mode.path) {
              return (
                <div key={mode.id} aria-disabled="true" className={cn(closedSlotClass, spanClass)}>
                  <span className="truncate">{mode.title}</span>
                  {isModeClosed ? <ClosedBadge /> : !isWholeGameDisabled && <ComingSoonBadge />}
                </div>
              );
            }

            return (
              <Button
                key={mode.id}
                asChild
                variant="outline"
                size="sm"
                className={`h-8 w-full px-2.5 text-xs sm:text-sm font-medium ${spanClass}`}
              >
                <motion.a
                  href={mode.path}
                  aria-label={`${game.title} ${mode.title}`}
                  data-agent-control={`site.mode.${mode.id}`}
                  onClick={handleEnter(mode.path)}
                  {...pressable}
                >
                  <span className="truncate">{mode.title}</span>
                </motion.a>
              </Button>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

function FooterLink({ link }: { link: ExternalLink }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground">
          <motion.a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            aria-label={link.label}
            variants={listItem}
            {...iconTappable}
          >
            {/* 品牌图标按 em 定尺寸，尺寸只能经字号给。 */}
            <BrandIcon name={link.icon} className="text-base" />
          </motion.a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{link.label}</TooltipContent>
    </Tooltip>
  );
}

/** 服务状态入口：与版本号、外链图标同一行，图标 + 文本，悬停不出现下划线。 */
function FooterStatusLink() {
  const linkClick = usePageLinkClick();
  return (
    <motion.a
      href={STATUS_PAGE_PATH}
      {...pressable}
      onClick={linkClick(STATUS_PAGE_PATH)}
      className="flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 font-serif text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <Activity aria-hidden="true" className="h-3.5 w-3.5" />
      服务状态
    </motion.a>
  );
}

function FriendLinkItem({ link }: { link: FriendLink }) {
  return (
    <motion.a
      href={link.href}
      target="_blank"
      rel="noreferrer"
      variants={listItem}
      {...pressable}
      className="group inline-flex min-h-8 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <span>{link.name}</span>
      <ArrowUpRight
        aria-hidden="true"
        // 外链指示：静止时比文字更浅，悬停沿外链方向挪动并归位到不透明。
        className="h-3 w-3 shrink-0 opacity-40 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100"
      />
    </motion.a>
  );
}

/** 版本号入口：直达关于页的更新日志标签（它有自己的独立地址）。 */
const VERSION_PAGE_PATH = aboutsTabHref("changelog");

export default function LandingPage() {
  const linkClick = usePageLinkClick();
  // 入口可用性读服务端运行期旋钮；没读到之前按全开。关掉的入口仍会渲染，只是置灰不可点。
  const features = useSiteFeatures();

  // 展示版本号取自更新日志里的最大版本号，与 package.json 无关；
  // 解析在构建期完成，运行时不再为了一个字符串背下整份日志。
  const version = appVersion || undefined;
  const commit = currentCommit;
  // 日志为空时版本号未知，用 ∞ 占位而不是留空。
  const versionLabel = `V${version ?? "∞"}${commit ? `(${commit})` : ""}`;

  return (
    <div className="relative grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
      <Seo path="/" />
      {/* 右上角这一排：设置、账号与反馈，浮着不占页头的纵向空间；账号服务不可用时入口仍保留。 */}
      <div className="absolute right-3 top-3 z-panel flex items-center gap-1 sm:right-5 sm:top-4">
        <SettingsEntry />
        <AccountButton />
        <FeedbackButton />
      </div>
      {/* 手机竖屏收紧纵向节奏：标题下的说明行占掉的高度从这里的留白里让出来，三款游戏的全部入口仍一屏看全。
          上留白不低于右上角那排按钮的高度，标题不与它重叠；sm 起与矮屏的规则不受影响。 */}
      <header className="px-6 pb-[clamp(0.5rem,3svh,1.75rem)] pt-[clamp(0.75rem,8svh,5rem)] text-center [@media(width<40rem)_and_(height>680px)]:pb-[clamp(0.25rem,1svh,1.75rem)] [@media(width<40rem)_and_(height>680px)]:pt-[clamp(3rem,6svh,5rem)] [@media(max-height:680px)]:pb-1 [@media(max-height:680px)]:pt-2">
        <motion.h1
          variants={listItem}
          initial="initial"
          animate="animate"
          className="flex items-center justify-center gap-2 text-4xl font-bold sm:gap-3 sm:text-5xl md:gap-4 md:text-6xl [@media(max-height:680px)]:text-3xl"
        >
          Baka
          <img
            src="/assets/logo.gif"
            alt=""
            aria-hidden="true"
            className="h-12 rounded-md object-cover sm:h-14 md:h-16 [@media(max-height:680px)]:h-9"
          />
          Game
        </motion.h1>
        {/* 一行说清站里有什么：执行脚本的抓取器与玩家看到的首屏，和外壳对爬虫说的是同一件事。
            矮屏把空间留给游戏卡片。 */}
        <motion.p
          variants={listItem}
          initial="initial"
          animate="animate"
          className="mt-0.5 text-xs text-muted-foreground sm:mt-4 sm:text-base [@media(max-height:680px)]:hidden"
        >
          {/* 两句各自成块：放不下一行时在句间换行，不把「开一间房」拆成两半。 */}
          <span className="inline-block">谁是卧底、听歌猜歌、猜动漫角色。</span>
          <span className="inline-block">开一间房，把房号发进群。</span>
        </motion.p>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-xl overflow-y-auto sm:overflow-hidden px-4 py-1 sm:px-6 sm:py-2 [@media(max-height:680px)]:py-1">
        {/* 纵向居中交给子元素的 my-auto，而不是父级的 items-center：
            父级在内容超出容器时会把内容向上下两侧同时溢出，顶部那部分越过 header 且滚不回来；
            auto 边距在有空间时居中、空间不足时归零，矮屏下自然退化为顶部对齐。 */}
        <motion.div
          className="my-auto flex w-full flex-col gap-2 sm:gap-3"
          variants={listContainer(GAMES.length)}
          initial="initial"
          animate="animate"
        >
          {/* 客户端过旧的提醒落在游戏列表上方：底部那条浮层是网页新版本提醒的位置，
              两条「该更新了」叠在同一处会互相盖掉。壳没装或版本够新时整条不渲染。 */}
          <ClientUpdateNotice />
          {GAMES.map((game) => (
            <GameRow key={game.id} game={game} features={features} />
          ))}
          {/* Agent（MCP）在站点上的活动：首页就连上，位置随工具调用实时更新。 */}
          <SiteAgentPresence />
        </motion.div>
      </main>

      <footer className="flex flex-col items-center gap-1 px-6 pb-[clamp(0.5rem,4svh,3rem)] pt-1.5 sm:gap-2 sm:pt-2 [@media(width<40rem)_and_(height>680px)]:pb-[clamp(0.5rem,2svh,3rem)] [@media(max-height:680px)]:flex-row [@media(max-height:680px)]:flex-wrap [@media(max-height:680px)]:justify-center [@media(max-height:680px)]:gap-x-4 [@media(max-height:680px)]:gap-y-1 [@media(max-height:680px)]:pb-1 [@media(max-height:680px)]:pt-1">
        {/* 友情链接 */}
        <motion.div
          className="flex flex-wrap items-center justify-center gap-1 text-xs"
          variants={listContainer(FRIEND_LINKS.length)}
          initial="initial"
          animate="animate"
        >
          {/* 分组标签按装饰性提示处理：沿用旧版更浅的一档，不与友情链接正文抢层级。 */}
          <span className="mr-0.5 text-muted-foreground/60 select-none">友情链接</span>
          {FRIEND_LINKS.map((link) => (
            <FriendLinkItem key={link.href} link={link} />
          ))}
        </motion.div>

        {/* 社区外链、反馈与版本详情 */}
        <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
          <motion.div
            className="flex items-center gap-1"
            variants={listContainer(EXTERNAL_LINKS.length)}
            initial="initial"
            animate="animate"
          >
            {EXTERNAL_LINKS.map((link) => (
              <FooterLink key={link.href} link={link} />
            ))}
          </motion.div>
          <motion.a
            href={VERSION_PAGE_PATH}
            {...pressable}
            onClick={linkClick(VERSION_PAGE_PATH)}
            className="flex min-h-8 items-center rounded-md px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {versionLabel}
          </motion.a>
          <ClientDownloadEntry compact />
          <FooterStatusLink />
        </div>
      </footer>

      <AccountDialogs />
    </div>
  );
}
