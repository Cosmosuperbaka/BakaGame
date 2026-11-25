import { useId, useState } from "react";
import { motion } from "framer-motion";
import { listItem, listContainer } from "@/lib/motion/Choreography";
import { iconTappable, pressable } from "@/lib/motion/Feedback";
import { usePageLinkClick, useSharedElementName } from "@/hooks/UsePageTransition";
import { Activity, ArrowUpRight, CircleQuestionMark } from "lucide-react";
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
import { REPOSITORY_URL } from "@/data/PageMeta";
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
    available: true,
    feature: "fakerEntry",
  },
  {
    id: "songuessr",
    lobbyPath: GAME_ROUTES.song.base,
    icon: "/assets/SongGuessr.gif",
    title: "Songuessr",
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
    icon: "/assets/CEE.png",
    title: "那个游戏",
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

/**
 * 还没公开的游戏：只占一个位置、写明「即将上线」，不给任何可点的入口，也不剧透名字与玩法。
 * 正式上线时把条目挪进 `GAMES`，换上真名、图标与入口。
 */
const MYSTERY_GAMES = ["神秘游戏1", "神秘游戏2", "神秘游戏3"] as const;

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

/**
 * 卡片里的一个入口：单一入口游戏的「开始游戏」与各子模式同一种按钮。
 * 窄屏铺满卡片宽度；`sm` 起入口排在卡片右侧、每格同宽，几张卡片的入口按列对齐。
 */
const entrySizeClass = "h-9 w-full sm:w-28";

/** 不可用入口的占位格：虚线、降色、不可点，尺寸与可点的按钮一致，关掉入口不让卡片跳动。 */
const closedSlotClass = cn(
  entrySizeClass,
  "flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-muted/40 px-1.5 text-center text-xs text-muted-foreground select-none"
);

interface GameEntryPoint {
  key: string;
  title: string;
  path?: string;
  available: boolean;
  feature?: keyof SiteFeatures;
  /** Agent 操作锚点：单一入口游戏按游戏、子模式按模式命名，沿用既有取值。 */
  agentControl: string;
}

/** 单一入口游戏的「开始游戏」与子模式统一成同一种入口，卡片只认一种排法。 */
function entryPointsOf(game: GameEntry): GameEntryPoint[] {
  if (!game.subModes)
    return [
      {
        key: "start",
        title: "开始游戏",
        path: game.path,
        available: game.available,
        feature: game.feature,
        agentControl: `site.game.${game.id}`,
      },
    ];
  return game.subModes.map((mode) => ({
    key: mode.id,
    title: mode.title,
    path: mode.path,
    available: mode.available,
    feature: mode.feature,
    agentControl: `site.mode.${mode.id}`,
  }));
}

/** 卡片头部的图标与游戏名。游戏名与大厅顶栏的游戏名是同一个跨页共享元素，只在两页互相过渡时命名。 */
function GameIdentity({ game }: { game: GameEntry }) {
  const sharedName = useSharedElementName("game-title", game.lobbyPath ?? false);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <img
        src={game.icon}
        alt=""
        aria-hidden="true"
        className="size-11 shrink-0 rounded-md border border-border object-cover sm:size-12"
      />
      <div className="min-w-0 flex-1">
        {/* 宽度贴合文字：快照只含字形，移到大厅顶栏时不带着整行留白一起缩放 */}
        <h2
          className="w-fit max-w-full truncate whitespace-nowrap text-base font-semibold sm:text-lg"
          style={{ viewTransitionName: sharedName }}
        >
          {game.title}
        </h2>
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

  const isWholeGameDisabled = !game.available;
  const entries = entryPointsOf(game);
  // 受控入口被后台关掉时**不隐藏**：格子留着、置灰、标注「暂时关闭」，
  // 让玩家看得出这个玩法存在但暂时不可进，而不是以为站点少了点什么。
  const isOpen = (entry: GameEntryPoint) =>
    !isWholeGameDisabled && entry.available && (!entry.feature || features[entry.feature]);
  const hasOpenEntry = entries.some(isOpen);

  return (
    <motion.li data-testid={`game-entry-${game.id}`} variants={listItem}>
      {/* 卡片容器本身不可点（入口是里面的按钮），悬停描边只留给还有入口能进的卡片，读作「这一张能进」。 */}
      <div
        aria-disabled={isWholeGameDisabled ? "true" : undefined}
        className={cn(
          "flex flex-col gap-3 rounded-md border bg-card p-3.5 shadow-2xs transition-colors sm:flex-row sm:items-center sm:gap-4 sm:p-4",
          hasOpenEntry && "hover:border-primary/40"
        )}
      >
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <GameIdentity game={game} />
          {isWholeGameDisabled && <ComingSoonBadge />}
        </div>

        {/* 整款未上线的单一入口游戏没有可展示的入口，只留头部的「即将上线」。 */}
        {isWholeGameDisabled && !game.subModes ? null : (
          <div
            className={cn(
              "grid gap-2 sm:flex sm:shrink-0 sm:justify-end",
              entries.length === 1 ? "grid-cols-1" : "grid-cols-2"
            )}
          >
            {entries.map((entry, index) => {
              // 三个入口在窄屏排成两行，首项独占一行：三等分时每格不到 110px，放不下模式名加「即将上线」。
              const spanClass =
                entries.length === 3 && index === 0 ? "max-sm:col-span-2" : undefined;
              const isClosed = !isWholeGameDisabled && entry.available && !isOpen(entry);

              if (!isOpen(entry) || !entry.path) {
                return (
                  <div
                    key={entry.key}
                    aria-disabled="true"
                    className={cn(closedSlotClass, spanClass)}
                  >
                    <span className="truncate">{entry.title}</span>
                    {isClosed ? <ClosedBadge /> : !isWholeGameDisabled && <ComingSoonBadge />}
                  </div>
                );
              }

              return (
                <Button
                  key={entry.key}
                  asChild
                  variant="outline"
                  className={cn(entrySizeClass, "px-3", spanClass)}
                >
                  <motion.a
                    href={entry.path}
                    aria-label={`${game.title} ${entry.title}`}
                    data-agent-control={entry.agentControl}
                    onClick={handleEnter(entry.path)}
                    {...pressable}
                  >
                    <span className="truncate">{entry.title}</span>
                  </motion.a>
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </motion.li>
  );
}

/**
 * 还没公开的游戏：虚线、无底色、降色，和能进的卡片一眼分开；整格不可点，也不响应悬停。
 * 窄屏三格并排，图标在上、名字在下；`sm` 起与上面的游戏卡同样横排。
 */
function MysteryGameCard({ title, index }: { title: string; index: number }) {
  return (
    <motion.li
      data-testid={`game-entry-mystery-${index + 1}`}
      variants={listItem}
      aria-disabled="true"
      className="flex min-w-0 flex-col items-center gap-2 rounded-md border border-dashed border-border px-2 py-3 text-center select-none sm:flex-row sm:gap-3 sm:p-3 sm:text-left"
    >
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-md bg-foreground/8 text-muted-foreground"
      >
        <CircleQuestionMark className="size-5" />
      </span>
      <h3 className="min-w-0 max-w-full truncate whitespace-nowrap text-sm font-semibold text-muted-foreground">
        {title}
      </h3>
    </motion.li>
  );
}

function UpcomingGames() {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      {/* 分组标题后面拖一条细线，把「能玩的」和「还没来的」分成两段，不另加卡片或底色。 */}
      <h2
        id={headingId}
        className="flex items-center gap-3 px-0.5 text-xs font-medium text-muted-foreground after:h-px after:flex-1 after:bg-border"
      >
        即将上线
      </h2>
      <motion.ul
        className="grid grid-cols-3 gap-2 sm:gap-3"
        variants={listContainer(MYSTERY_GAMES.length)}
      >
        {MYSTERY_GAMES.map((title, index) => (
          <MysteryGameCard key={title} title={title} index={index} />
        ))}
      </motion.ul>
    </section>
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

/** 页脚文字入口共用的外形：与图标钮同高，悬停铺 accent 底，不出现下划线。 */
const footerTextLinkClass =
  "flex min-h-8 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground";

/** 页脚分组标题按装饰性提示处理：沿用旧版更浅的一档，不与链接正文抢层级。 */
const footerGroupLabelClass = "px-2 text-xs text-muted-foreground/60 select-none";

/** 服务状态入口：图标 + 文本，悬停不出现下划线。 */
function FooterStatusLink() {
  const linkClick = usePageLinkClick();
  return (
    <motion.a
      href={STATUS_PAGE_PATH}
      {...pressable}
      onClick={linkClick(STATUS_PAGE_PATH)}
      className={cn(footerTextLinkClass, "font-ui font-medium")}
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
      className={cn(footerTextLinkClass, "group gap-1")}
    >
      <span className="truncate">{link.name}</span>
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

/**
 * 页脚分三组：友情链接、本站（下载客户端、服务状态）与社区外链加版本号。
 * 窄屏排成左右两栏加一条底行：友情链接贴左缘、本站入口贴右缘，底行左边社区外链、右边版本号，
 * 每组各占一块，不靠换行把几组挤成一团；`sm` 起收回居中的两行：友情链接一行，其余一行。
 */
function LandingFooter({ versionLabel }: { versionLabel: string }) {
  const linkClick = usePageLinkClick();
  return (
    // 左栏取剩余宽度、右栏按内容收紧：等分两栏时友情链接的长名字会被截断；比常见手机还窄时两栏改成上下排。
    <footer className="mt-auto grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 max-[360px]:grid-cols-1 gap-y-3 border-t border-border pt-4 pb-5 sm:flex sm:flex-col sm:items-center sm:gap-1.5 sm:border-t-0 sm:pt-2 sm:pb-[clamp(0.75rem,4svh,2.5rem)]">
      <motion.nav
        aria-label="友情链接"
        className="flex min-w-0 flex-col items-start gap-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center sm:gap-1"
        variants={listContainer(FRIEND_LINKS.length)}
        initial="initial"
        animate="animate"
      >
        <span className={cn(footerGroupLabelClass, "pb-1 sm:pb-0")}>友情链接</span>
        {FRIEND_LINKS.map((link) => (
          <FriendLinkItem key={link.href} link={link} />
        ))}
      </motion.nav>

      {/* 窄屏拆开这一层：本站入口落在右栏，社区外链与版本号落在底行；`sm` 起几项并成居中的一行，本站入口排在最后。 */}
      <div className="contents sm:flex sm:max-w-full sm:flex-wrap sm:items-center sm:justify-center sm:gap-2">
        <div className="flex flex-col items-end gap-0.5 max-[360px]:items-start sm:order-last sm:flex-row sm:items-center sm:gap-2">
          <span className={cn(footerGroupLabelClass, "pb-1 sm:hidden")}>本站</span>
          <ClientDownloadEntry compact />
          <FooterStatusLink />
        </div>
        <div className="col-span-full flex items-center justify-between gap-2 sm:contents">
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
            className={cn(footerTextLinkClass, "font-mono")}
          >
            {versionLabel}
          </motion.a>
        </div>
      </div>
    </footer>
  );
}

export default function LandingPage() {
  // 入口可用性读服务端运行期旋钮；没读到之前按全开。关掉的入口仍会渲染，只是置灰不可点。
  const features = useSiteFeatures();

  // 展示版本号取自更新日志里的最大版本号，与 package.json 无关；
  // 解析在构建期完成，运行时不再为了一个字符串背下整份日志。
  const version = appVersion || undefined;
  const commit = currentCommit;
  // 日志为空时版本号未知，用 ∞ 占位而不是留空。
  const versionLabel = `V${version ?? "∞"}${commit ? `(${commit})` : ""}`;

  return (
    // 整页一起滚：游戏、预告与页脚按顺序排下来，窄屏不再把游戏列表夹在页头与页脚之间的一小段里单独滚。
    <div className="relative h-full min-h-0 overflow-x-hidden overflow-y-auto">
      <Seo path="/" />
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-4 sm:px-6">
        {/* 窄屏是一条顶栏：站名靠左，设置、账号与反馈三个同尺寸的图标钮靠右。
            `sm` 起站名放大居中，三个入口浮在页面右上角，不占页头的纵向空间。 */}
        <header className="flex items-center justify-between gap-2 pt-3 pb-1 sm:block sm:pt-[clamp(3.5rem,9svh,5.5rem)] sm:pb-[clamp(1rem,4svh,2.5rem)] [@media(min-width:40rem)_and_(max-height:680px)]:pt-12 [@media(min-width:40rem)_and_(max-height:680px)]:pb-3">
          <motion.h1
            variants={listItem}
            initial="initial"
            animate="animate"
            className="flex min-w-0 items-center gap-1 text-lg font-bold sm:justify-center sm:gap-3 sm:text-5xl md:gap-4 md:text-6xl [@media(min-width:40rem)_and_(max-height:680px)]:text-3xl"
          >
            Baka
            {/* 动图自带白底（素材不改）：暗色下把白压到与标题文字同一明度，读作和字同亮的一块，不再是刺眼的白方块。
                窄屏顶栏放不下时只让动图收窄、居中裁掉两侧，站名的字与右边的图标钮都不被挤压；再窄就只留字。 */}
            <img
              src="/assets/logo.gif"
              alt=""
              aria-hidden="true"
              className="aspect-video h-6 w-auto min-w-0 shrink rounded-md object-cover max-[360px]:hidden sm:h-14 md:h-16 dark:brightness-90 [@media(min-width:40rem)_and_(max-height:680px)]:h-9"
            />
            Game
          </motion.h1>
          {/* 账号服务不可用时入口仍保留。 */}
          <div className="z-panel flex shrink-0 items-center gap-0.5 sm:absolute sm:right-5 sm:top-4 sm:gap-1">
            <SettingsEntry />
            <AccountButton />
            <FeedbackButton compact="narrow" />
          </div>
        </header>

        {/* 纵向居中交给 my-auto：有空间时游戏区落在页头与页脚之间的正中，空间不足时归零，整页顺着往下滚。 */}
        <main className="flex flex-col gap-6 pt-3 pb-8 sm:my-auto sm:pt-2 sm:pb-6">
          {/* 客户端过旧的提醒落在游戏列表上方：底部那条浮层是网页新版本提醒的位置，
              两条「该更新了」叠在同一处会互相盖掉。壳没装或版本够新时整条不渲染。 */}
          <ClientUpdateNotice />
          <motion.div
            className="flex flex-col gap-6"
            variants={listContainer(GAMES.length + MYSTERY_GAMES.length)}
            initial="initial"
            animate="animate"
          >
            <ul aria-label="游戏" className="flex flex-col gap-2.5 sm:gap-3">
              {GAMES.map((game) => (
                <GameRow key={game.id} game={game} features={features} />
              ))}
            </ul>
            <UpcomingGames />
          </motion.div>
          {/* Agent（MCP）在站点上的活动：首页就连上，位置随工具调用实时更新。 */}
          <SiteAgentPresence />
        </main>

        <LandingFooter versionLabel={versionLabel} />
      </div>

      <AccountDialogs />
    </div>
  );
}
