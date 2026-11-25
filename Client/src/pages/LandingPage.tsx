import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listItem, listContainer } from "@/lib/motion/Choreography";
import { iconTappable, pressable } from "@/lib/motion/Feedback";
import { readoutSwap } from "@/lib/motion/NamedMoves";
import { usePageLinkClick, useSharedElementName } from "@/hooks/UsePageTransition";
import {
  Activity,
  ArrowUpRight,
  CirclePause,
  Clock,
  Medal,
  Play,
  Trophy,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { BrandIcon } from "@/components/common/BrandIcon";
import type { BrandIconName } from "@/data/BrandIconPaths";
import { Button } from "@/components/ui/Button";
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
  /** 入口胶囊左端的玩法图标：一人、多人、排位、锦标赛各一种，所有主题同一套。 */
  icon: LucideIcon;
  /** 窄屏海报胶囊上的短名。 */
  short: string;
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
  /** 海报封面；神秘游戏不剧透，省略后画一个问号。 */
  icon?: string;
  /** 低分辨率的像素动图：不铺满裁切，居中留白、按像素放大。 */
  pixelated?: true;
  /** 海报底色，取自封面的主色；封面留白处与加载前露出来的就是它。神秘游戏省略，用统一的墨色。 */
  accent?: string;
  /** 条目主标题 */
  title: string;
  available: boolean;
  /** 单一入口游戏挂的服务端开关，语义同子模式的 `feature`。 */
  feature?: keyof SiteFeatures;
  subModes?: GameSubMode[];
  /** 还没公开的游戏：海报与正式游戏一样，「开始游戏」点了不导航，只在胶囊上提示「敬请期待」。 */
  mystery?: true;
}

const PLAYABLE_GAMES: GameEntry[] = [
  {
    id: "whoisfaker",
    path: GAME_ROUTES.faker.base,
    lobbyPath: GAME_ROUTES.faker.base,
    icon: "/assets/Faker.png",
    accent: "#b3213a",
    title: "Who is Faker",
    available: true,
    feature: "fakerEntry",
  },
  {
    id: "songuessr",
    lobbyPath: GAME_ROUTES.song.base,
    icon: "/assets/SongGuessr.gif",
    pixelated: true,
    accent: "#ef7d1a",
    title: "Songuessr",
    available: true,
    subModes: [
      {
        id: "singleplayer",
        title: "单人模式",
        icon: UserRound,
        short: "单人",
        path: `${GAME_ROUTES.song.base}/solo`,
        available: true,
        feature: "songSoloEntry",
      },
      {
        id: "multiplayer",
        title: "多人模式",
        icon: UsersRound,
        short: "多人",
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
    accent: "#3d5fc4",
    title: "那个游戏",
    available: true,
    subModes: [
      {
        id: "multiplayer",
        title: "多人模式",
        icon: UsersRound,
        short: "多人",
        path: GAME_ROUTES.cee.base,
        available: true,
        feature: "ceeMultiplayerEntry",
      },
      {
        id: "ranked",
        title: "排位赛",
        icon: Medal,
        short: "排位",
        path: `${GAME_ROUTES.cee.base}/ranked`,
        available: true,
        feature: "ceeRankedEntry",
      },
      {
        id: "tournament",
        title: "锦标赛",
        icon: Trophy,
        short: "锦标赛",
        available: false,
      },
    ],
  },
];

/**
 * 还没公开的游戏：和正式游戏排在同一面海报墙上、用同一种海报，好提前看六款并列时的样子。
 * 不剧透名字与封面；正式上线时换上真名、封面与入口，去掉 `mystery`。
 */
const MYSTERY_GAMES: GameEntry[] = [1, 2, 3].map((n) => ({
  id: `mystery-${n}`,
  title: `神秘游戏${n}`,
  available: true,
  mystery: true,
}));

const GAMES: GameEntry[] = [...PLAYABLE_GAMES, ...MYSTERY_GAMES];

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

/**
 * 顶栏、游戏区与页脚共用的内容列：三段左右边缘对齐，分隔线铺满整页宽度。
 * 海报在宽屏排三列，比大厅宽两档才放得下。
 */
const pageColumnClass = "mx-auto w-full max-w-5xl px-4 sm:px-6 md:px-10";

/** 神秘游戏点「开始游戏」后「敬请期待」停留的时长：给玩家读完提示，不参与任何业务时序。 */
const MYSTERY_HINT_MS = 2_000;

/**
 * 海报上的入口胶囊：压在封面暗部上，纸底墨字是能进的入口，虚线降色是进不去的入口。
 * 左端嵌一枚玩法图标的色块，胶囊只在左侧留一圈窄边贴住它，同心的两层轮廓读作一枚按钮；
 * 色块取游戏的主题色，把入口和海报连成一件东西。轮廓与颜色都取海报令牌，各主题自己定材料。
 */
const pillClass =
  "inline-flex h-8 shrink-0 items-center gap-1 rounded-poster-pill pr-2.5 pl-1 text-xs font-bold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-poster-paper sm:h-9 sm:gap-1.5 sm:pr-3.5 sm:text-sm";
const openPillClass = cn(pillClass, "bg-poster-paper text-poster-ink shadow-sm");
const closedPillClass = cn(
  pillClass,
  "border border-dashed border-poster-paper/50 bg-poster-ink/40 font-medium text-poster-paper/80 select-none"
);
const pillIconClass =
  "grid size-6 shrink-0 place-items-center rounded-poster-pill sm:size-7 [&_svg]:size-3.5 sm:[&_svg]:size-4";

/** 胶囊左端的图标色块：实心的是能进的入口；进不去的只画一圈虚线框，里面换成状态图标。 */
function PillIcon({ icon: Icon, tone }: { icon: LucideIcon; tone?: string }) {
  if (!tone)
    return (
      <span aria-hidden="true" className={cn(pillIconClass, "border border-dashed border-current")}>
        <Icon />
      </span>
    );
  return (
    <span
      aria-hidden="true"
      className={cn(pillIconClass, "text-poster-paper")}
      // 主题色直接作底时，最亮的那款（Songuessr 的橙）压纸色图标只有约 2.7:1；
      // 掺进 15% 墨色后三款主题色在三套主题下都不低于 3:1（非文字图形口径），也和海报底色拉开一层。
      style={{ backgroundColor: `color-mix(in oklab, ${tone} 85%, var(--poster-ink))` }}
    >
      <Icon strokeWidth={2.5} className={Icon === Play ? "fill-current" : undefined} />
    </span>
  );
}

/** 整款还没上线的游戏挂在标题旁的标记：和进不去的入口同一种虚线降色，海报是深色底，不沿用页面上的徽章配色。 */
function ComingSoonBadge() {
  return (
    <span className="shrink-0 rounded-poster-pill border border-dashed border-poster-paper/50 bg-poster-ink/40 px-2 py-0.5 text-2xs font-medium text-poster-paper/80 select-none">
      即将上线
    </span>
  );
}

interface GameEntryPoint {
  key: string;
  title: string;
  icon: LucideIcon;
  /** 窄屏胶囊上的短名；与全名相同时只渲染一份。 */
  short: string;
  path?: string;
  available: boolean;
  feature?: keyof SiteFeatures;
  /** Agent 操作锚点：单一入口游戏按游戏、子模式按模式命名，沿用既有取值。 */
  agentControl: string;
}

/** 单一入口游戏的「开始游戏」与子模式统一成同一种入口，海报只认一种排法。 */
function entryPointsOf(game: GameEntry): GameEntryPoint[] {
  if (!game.subModes)
    return [
      {
        key: "start",
        title: "开始游戏",
        icon: Play,
        short: "开始",
        path: game.path,
        available: game.available,
        feature: game.feature,
        agentControl: `site.game.${game.id}`,
      },
    ];
  return game.subModes.map((mode) => ({
    key: mode.id,
    title: mode.title,
    icon: mode.icon,
    short: mode.short,
    path: mode.path,
    available: mode.available,
    feature: mode.feature,
    agentControl: `site.mode.${mode.id}`,
  }));
}

/**
 * 海报变窄时胶囊只放得下短名：两列手机（`sm` 以下）和三列平板（`md`–`lg`）都是窄海报。
 * 入口的可访问名另由 aria-label 给全。
 */
const compactOnlyClass = "sm:max-md:hidden lg:hidden";
const roomyOnlyClass = "max-sm:hidden md:max-lg:hidden";

function EntryLabel({ title, short }: { title: string; short: string }) {
  if (title === short) return <span>{title}</span>;
  return (
    <>
      <span className={compactOnlyClass}>{short}</span>
      <span className={roomyOnlyClass}>{title}</span>
    </>
  );
}

/**
 * 海报的封面：铺满整张海报，悬停时轻推近一点。像素动图放大会糊，改成居中留白、按像素放大，铺在主题色上。
 * 神秘游戏没有封面：斜纹底上一个大问号，位置偏上，给下面的游戏名与入口让出位置。
 */
function PosterArt({ game }: { game: GameEntry }) {
  if (!game.icon)
    return (
      <div
        aria-hidden="true"
        className="absolute inset-0 grid place-items-center bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.06)_0_10px,transparent_10px_20px)] pb-[38%]"
      >
        <span className="font-serif text-[7rem] leading-none font-black text-poster-paper opacity-20 select-none sm:text-[9rem]">
          ?
        </span>
      </div>
    );
  return (
    <img
      src={game.icon}
      alt=""
      aria-hidden="true"
      className={cn(
        "absolute inset-0 size-full transition-transform duration-(--motion-duration-base) group-hover:scale-105",
        game.pixelated ? "object-contain p-[12%] [image-rendering:pixelated]" : "object-cover"
      )}
    />
  );
}

/** 写进整页唯一那个读屏播报区的文字。 */
type Announce = Dispatch<SetStateAction<string>>;

/**
 * 神秘游戏的「开始游戏」：外形与按压反馈都和正式入口一样，但不是链接，点了不导航；
 * 胶囊上的字换成「敬请期待」停一会儿再换回来，两段文字在同一格里交叉，读屏经页面的播报区念出同一句。
 */
function MysteryEntryButton({
  gameTitle,
  entry,
  tone,
  announce,
}: {
  gameTitle: string;
  entry: GameEntryPoint;
  tone: string;
  announce: Announce;
}) {
  const [hinting, setHinting] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const notice = `${gameTitle}敬请期待`;
  const showHint = () => {
    setHinting(true);
    announce(notice);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setHinting(false);
      // 只清自己的那句：期间点过另一款神秘游戏，播报区已经换成那一款的。
      announce((current) => (current === notice ? "" : current));
    }, MYSTERY_HINT_MS);
  };

  return (
    <motion.button
      type="button"
      // 交替期间旧文案还在淡出，名字固定写在按钮上，读屏与按名查找都只得到当前这一份。
      aria-label={`${gameTitle} ${entry.title}`}
      className={openPillClass}
      onClick={showHint}
      {...pressable}
    >
      <PillIcon icon={entry.icon} tone={tone} />
      <span className="relative flex overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={hinting ? "hint" : "idle"}
            aria-hidden="true"
            variants={readoutSwap}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex"
          >
            {hinting ? "敬请期待" : <EntryLabel title={entry.title} short={entry.short} />}
          </motion.span>
        </AnimatePresence>
      </span>
    </motion.button>
  );
}

/**
 * 一款游戏一张海报：封面铺满，自下而上压一层暗幕，游戏名与入口胶囊落在暗幕上。
 * 海报本身不可点（入口是里面的胶囊）；底色取各游戏自己的主题色，暗幕、字与胶囊的材料取主题的海报令牌，
 * 亮暗页面上是同一张图。
 * 比例只是下限：裁切用 `overflow-clip` 而不是 `overflow-hidden`，后者会让海报不再按内容撑高，
 * 入口多的那张在矮横幅里会把游戏名顶出画面；同一行的海报再一起拉到最高那张的高度。
 */
function GamePoster({
  game,
  features,
  announce,
}: {
  game: GameEntry;
  features: SiteFeatures;
  announce: Announce;
}) {
  const linkClick = usePageLinkClick();
  // 只用来挡住重复点击：分块还在加载时旧页仍可点，第二次点击会往历史里再压一条同样的记录。
  const [enteringPath, setEnteringPath] = useState<string | null>(null);
  // 游戏名与大厅顶栏的游戏名是同一个跨页共享元素，只在两页互相过渡时命名。
  const sharedName = useSharedElementName("game-title", game.lobbyPath ?? false);

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
  // 受控入口被后台关掉时**不隐藏**：胶囊留着、改成虚线、标注「暂时关闭」，
  // 让玩家看得出这个玩法存在但暂时不可进，而不是以为站点少了点什么。
  const isOpen = (entry: GameEntryPoint) =>
    !isWholeGameDisabled && entry.available && (!entry.feature || features[entry.feature]);

  // 色块与海报同色：神秘游戏没有主题色，取主题给的留白色。
  const tone = game.accent ?? "var(--poster-blank)";

  return (
    <motion.li
      data-testid={`game-entry-${game.id}`}
      variants={listItem}
      aria-disabled={isWholeGameDisabled ? "true" : undefined}
      // 外层是卡面：衬边为零的主题里被封面盖满，有衬边的主题在封面四周露出一圈。
      className="group flex aspect-[3/4] flex-col place-self-stretch rounded-xl bg-card p-poster-mat shadow-md md:aspect-[5/4]"
    >
      <div
        className="relative isolate flex flex-1 flex-col justify-end overflow-clip rounded-[calc(var(--radius)+2*var(--radius-step)-var(--poster-mat))] text-poster-paper"
        style={{ backgroundColor: tone }}
      >
        <PosterArt game={game} />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-linear-to-t from-poster-ink/85 via-poster-ink/35 to-transparent"
        />
        <div className="relative flex flex-col gap-2.5 p-3 sm:gap-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            {/* 宽度贴合文字：快照只含字形，移到大厅顶栏时不带着整行留白一起缩放 */}
            <h3
              className="w-fit text-lg leading-tight font-black tracking-tight drop-shadow sm:text-2xl"
              style={{ viewTransitionName: sharedName }}
            >
              {game.title}
            </h3>
            {isWholeGameDisabled && <ComingSoonBadge />}
          </div>

          {/* 整款未上线的单一入口游戏没有可展示的入口，只留标题旁的「即将上线」。 */}
          {/* 手机两列的海报只有一百多像素宽，两枚胶囊并不排，入口按行竖排、每行铺满海报宽度。 */}
          {isWholeGameDisabled && !game.subModes ? null : (
            <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-1.5">
              {entries.map((entry) => {
                if (game.mystery)
                  return (
                    <MysteryEntryButton
                      key={entry.key}
                      gameTitle={game.title}
                      entry={entry}
                      tone={tone}
                      announce={announce}
                    />
                  );

                if (!isOpen(entry) || !entry.path) {
                  const isClosed = !isWholeGameDisabled && entry.available;
                  return (
                    <span key={entry.key} aria-disabled="true" className={closedPillClass}>
                      {/* 进不去的入口，色块里换成状态图标；窄海报只放得下短名，状态文字留给读屏。 */}
                      <PillIcon icon={isClosed ? CirclePause : Clock} />
                      <EntryLabel title={entry.title} short={entry.short} />
                      <span className="opacity-70 max-sm:sr-only md:max-lg:sr-only">
                        {isClosed ? "暂时关闭" : "即将上线"}
                      </span>
                    </span>
                  );
                }

                return (
                  <motion.a
                    key={entry.key}
                    href={entry.path}
                    aria-label={`${game.title} ${entry.title}`}
                    data-agent-control={entry.agentControl}
                    onClick={handleEnter(entry.path)}
                    className={openPillClass}
                    {...pressable}
                  >
                    <PillIcon icon={entry.icon} tone={tone} />
                    <EntryLabel title={entry.title} short={entry.short} />
                  </motion.a>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </motion.li>
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
const footerGroupLabelClass = "px-2 pb-1 text-xs text-muted-foreground/60 select-none lg:pb-0";

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
 * 页脚与顶栏对称：一条分隔线铺满整页，内容落在同一条内容列里。
 * 上半是两栏，友情链接贴左、本站入口（下载客户端、服务状态）贴右；下半一行，社区外链在左、版本号在右。
 * 两栏在 `lg` 之前竖排，宽屏才各自排成一行；比常见手机还窄时两栏改成上下排。
 */
function LandingFooter({ versionLabel }: { versionLabel: string }) {
  const linkClick = usePageLinkClick();
  return (
    <footer className="border-t border-border">
      {/* 左栏取剩余宽度、右栏按内容收紧：等分两栏时友情链接的长名字会被截断。 */}
      <div
        className={cn(
          pageColumnClass,
          "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 pt-4 pb-5 max-[360px]:grid-cols-1 sm:pt-5 sm:pb-6"
        )}
      >
        <motion.nav
          aria-label="友情链接"
          className="flex min-w-0 flex-col items-start gap-0.5 lg:flex-row lg:flex-wrap lg:items-center lg:gap-1"
          variants={listContainer(FRIEND_LINKS.length)}
          initial="initial"
          animate="animate"
        >
          <span className={footerGroupLabelClass}>友情链接</span>
          {FRIEND_LINKS.map((link) => (
            <FriendLinkItem key={link.href} link={link} />
          ))}
        </motion.nav>

        <div className="flex flex-col items-end gap-0.5 max-[360px]:items-start lg:flex-row lg:items-center lg:gap-1">
          <span className={footerGroupLabelClass}>本站</span>
          <ClientDownloadEntry compact />
          <FooterStatusLink />
        </div>

        <div className="col-span-full flex items-center justify-between gap-2">
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
  const gamesHeadingId = useId();
  const [mysteryNotice, setMysteryNotice] = useState("");

  // 展示版本号取自更新日志里的最大版本号，与 package.json 无关；
  // 解析在构建期完成，运行时不再为了一个字符串背下整份日志。
  const version = appVersion || undefined;
  const commit = currentCommit;
  // 日志为空时版本号未知，用 ∞ 占位而不是留空。
  const versionLabel = `V${version ?? "∞"}${commit ? `(${commit})` : ""}`;

  return (
    // 整页一起滚：顶栏、游戏网格与页脚按顺序排下来，不把游戏列表夹在页头与页脚之间单独滚。
    <div className="relative h-full min-h-0 overflow-x-hidden overflow-y-auto">
      <Seo path="/" />
      <div className="flex min-h-full flex-col">
        {/* 顶栏与大厅同一种排法：站名靠左，设置、账号与反馈靠右，底边一条分隔线铺满整页。
            窄屏三个入口同为图标钮，和站名排在同一行。 */}
        <header className="border-b border-border">
          <div
            className={cn(
              pageColumnClass,
              // 横屏手机只有三四百像素高，顶栏按窄屏的紧凑档留白，把高度让给游戏卡。
              "flex items-center justify-between gap-3 pt-4 pb-3 sm:pt-6 sm:pb-4 md:pt-8 [@media(max-height:480px)]:pt-3 [@media(max-height:480px)]:pb-3"
            )}
          >
            <motion.h1
              variants={listItem}
              initial="initial"
              animate="animate"
              className="flex min-w-0 items-center gap-1 text-lg font-bold sm:gap-2 sm:text-2xl"
            >
              Baka
              {/* 动图自带白底（素材不改）：暗色下把白压到与标题文字同一明度，读作和字同亮的一块，不再是刺眼的白方块。
                  窄屏顶栏放不下时只让动图收窄、居中裁掉两侧，站名的字与右边的图标钮都不被挤压；再窄就只留字。 */}
              <img
                src="/assets/logo.gif"
                alt=""
                aria-hidden="true"
                className="aspect-video h-6 w-auto min-w-0 shrink rounded-md object-cover max-[360px]:hidden sm:h-8 dark:brightness-90"
              />
              Game
            </motion.h1>
            {/* 账号服务不可用时入口仍保留。 */}
            <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
              <SettingsEntry />
              <AccountButton />
              <FeedbackButton compact="narrow" />
            </div>
          </div>
        </header>

        <main className={cn(pageColumnClass, "flex flex-1 flex-col gap-4 pt-5 pb-10 sm:pt-8")}>
          {/* 客户端过旧的提醒落在游戏列表上方：底部那条浮层是网页新版本提醒的位置，
              两条「该更新了」叠在同一处会互相盖掉。壳没装或版本够新时整条不渲染。 */}
          <ClientUpdateNotice />
          {/* 海报自己说明了这是什么，标题只留给读屏与按名查找。 */}
          <h2 id={gamesHeadingId} className="sr-only">
            全部游戏
          </h2>
          {/* 手机两列竖幅海报排成三行；`md` 起（平板、横屏手机与桌面）三列横幅海报排成两行。 */}
          <motion.ul
            aria-labelledby={gamesHeadingId}
            className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-5"
            variants={listContainer(GAMES.length)}
            initial="initial"
            animate="animate"
          >
            {GAMES.map((game) => (
              <GamePoster
                key={game.id}
                game={game}
                features={features}
                announce={setMysteryNotice}
              />
            ))}
          </motion.ul>
          {/* 整页只留这一处常驻播报区：模态框打开时，播报区的祖先不会被设成对读屏隐藏；
              放进每枚按钮会把按钮一起留在模态框背后可读，放在这里只留下这一个空节点。 */}
          <span className="sr-only" aria-live="polite">
            {mysteryNotice}
          </span>
          {/* Agent（MCP）在站点上的活动：首页就连上，位置随工具调用实时更新。 */}
          <SiteAgentPresence />
        </main>

        <LandingFooter versionLabel={versionLabel} />
      </div>

      <AccountDialogs />
    </div>
  );
}
