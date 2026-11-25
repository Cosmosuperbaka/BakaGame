import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { listItem, listContainer } from "@/lib/motion/Choreography";
import { iconTappable, pressable } from "@/lib/motion/Feedback";
import { readoutSwap } from "@/lib/motion/NamedMoves";
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
  /** 卡片封面；神秘游戏不剧透，省略后画一块问号。 */
  icon?: string;
  /** 条目主标题 */
  title: string;
  available: boolean;
  /** 单一入口游戏挂的服务端开关，语义同子模式的 `feature`。 */
  feature?: keyof SiteFeatures;
  subModes?: GameSubMode[];
  /** 还没公开的游戏：卡片与正式游戏一样，「开始游戏」点了不导航，只在按钮上提示「敬请期待」。 */
  mystery?: true;
}

const PLAYABLE_GAMES: GameEntry[] = [
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
 * 还没公开的游戏：和正式游戏排在同一张网格里、用同一种卡片，好提前看六款并列时的样子。
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
 * 比大厅宽一档，宽屏的两列游戏卡才放得下入口按钮。
 */
const pageColumnClass = "mx-auto w-full max-w-4xl px-4 sm:px-6 md:px-10";

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
 * 窄屏两格一行铺满；`sm` 的单列卡片宽度富余，入口按固定宽度靠左排成一行，几张卡片按列对齐；
 * `md` 起卡片排成两列、内容区收窄，回到两格一行铺满。
 */
const entrySizeClass = "h-9 w-full sm:w-28 md:w-full";

/**
 * 不可用入口的占位格：虚线、降色、不可点，高度与可点的按钮一致，关掉入口不让卡片跳动。
 * 排成一行时至少与按钮同宽、按内容放宽，模式名加徽章不被截断。
 */
const closedSlotClass = cn(
  entrySizeClass,
  "flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-muted/40 px-1.5 text-center text-xs text-muted-foreground select-none sm:w-auto sm:min-w-28 md:w-full md:min-w-0"
);

/** 神秘游戏点「开始游戏」后「敬请期待」停留的时长：给玩家读完提示，不参与任何业务时序。 */
const MYSTERY_HINT_MS = 2_000;

interface GameEntryPoint {
  key: string;
  title: string;
  path?: string;
  available: boolean;
  feature?: keyof SiteFeatures;
  /** Agent 操作锚点：单一入口游戏按游戏、子模式按模式命名，沿用既有取值。 */
  agentControl: string;
}

/**
 * 两格一行时哪些入口独占一行：点不进去的格子（暂时关闭、即将上线）要放下模式名加徽章，半格放不下；
 * 能进的入口按原顺序两两并排，被占位格隔开或排到末尾而落单的那个也独占一行，不留半行空位。
 */
function fullRowKeys(entries: GameEntryPoint[], canEnter: (entry: GameEntryPoint) => boolean) {
  const full = new Set<string>();
  let unpaired: string | null = null;
  for (const entry of entries) {
    if (canEnter(entry)) {
      unpaired = unpaired ? null : entry.key;
      continue;
    }
    if (unpaired) full.add(unpaired);
    unpaired = null;
    full.add(entry.key);
  }
  if (unpaired) full.add(unpaired);
  return full;
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

/**
 * 卡片左侧的封面：贴满卡片整高的一条竖幅，按卡片高度居中裁切，读作这款游戏的「盒封」。
 * 封面绝对定位铺满，不参与撑高卡片；神秘游戏没有封面，同一块底上画一个问号。
 */
function GameCover({ game }: { game: GameEntry }) {
  return (
    <div
      aria-hidden="true"
      className="relative grid w-20 shrink-0 place-items-center border-r border-border bg-foreground/8 text-muted-foreground max-[360px]:w-14 sm:w-24 lg:w-28"
    >
      {game.icon ? (
        <img src={game.icon} alt="" className="absolute inset-0 size-full object-cover" />
      ) : (
        <CircleQuestionMark className="size-7 sm:size-8" />
      )}
    </div>
  );
}

/** 卡片上的游戏名。它与大厅顶栏的游戏名是同一个跨页共享元素，只在两页互相过渡时命名。 */
function GameTitle({ game }: { game: GameEntry }) {
  const sharedName = useSharedElementName("game-title", game.lobbyPath ?? false);
  return (
    // 宽度贴合文字：快照只含字形，移到大厅顶栏时不带着整行留白一起缩放
    <h3
      className="w-fit max-w-full truncate whitespace-nowrap text-base font-semibold sm:text-lg"
      style={{ viewTransitionName: sharedName }}
    >
      {game.title}
    </h3>
  );
}

/** 写进整页唯一那个读屏播报区的文字。 */
type Announce = Dispatch<SetStateAction<string>>;

/**
 * 神秘游戏的「开始游戏」：外形、尺寸与按压反馈都和正式入口一样，但不是链接，点了不导航；
 * 按钮上的字换成「敬请期待」停一会儿再换回来，两段文字在同一格里交叉，读屏经页面的播报区念出同一句。
 */
function MysteryEntryButton({
  gameTitle,
  className,
  announce,
}: {
  gameTitle: string;
  className?: string;
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
    <Button
      type="button"
      variant="outline"
      // 交替期间旧文案还在淡出，名字固定写在按钮上，读屏与按名查找都只得到当前这一份。
      aria-label={`${gameTitle} 开始游戏`}
      className={className}
      onClick={showHint}
    >
      <span className="relative flex min-w-0 justify-center overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={hinting ? "hint" : "idle"}
            aria-hidden="true"
            variants={readoutSwap}
            initial="initial"
            animate="animate"
            exit="exit"
            className="truncate"
          >
            {hinting ? "敬请期待" : "开始游戏"}
          </motion.span>
        </AnimatePresence>
      </span>
    </Button>
  );
}

function GameCard({
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
  // 神秘游戏的入口没有地址，但同样是一枚能按的按钮。
  const canEnter = (entry: GameEntryPoint) =>
    isOpen(entry) && (game.mystery === true || entry.path !== undefined);
  const fullRow = fullRowKeys(entries, canEnter);

  return (
    <motion.li data-testid={`game-entry-${game.id}`} variants={listItem} className="flex">
      {/* 卡片容器本身不可点（入口是里面的按钮），悬停描边只留给还有入口能进的卡片，读作「这一张能进」。
          两列网格里同一行的卡片等高，入口贴着卡片底边，几张卡片的按钮落在同一条线上。 */}
      <div
        aria-disabled={isWholeGameDisabled ? "true" : undefined}
        className={cn(
          "flex w-full overflow-hidden rounded-md border bg-card shadow-2xs transition-colors",
          hasOpenEntry && "hover:border-primary/40"
        )}
      >
        <GameCover game={game} />

        {/* 比常见手机还窄时封面与留白各收一档，两枚并排的入口仍放得下四个字的模式名。 */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-3.5 max-[360px]:p-3 sm:gap-4 sm:p-4">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <GameTitle game={game} />
            {isWholeGameDisabled && <ComingSoonBadge />}
          </div>

          {/* 整款未上线的单一入口游戏没有可展示的入口，只留标题旁的「即将上线」。 */}
          {isWholeGameDisabled && !game.subModes ? null : (
            <div className="mt-auto grid grid-cols-2 gap-2 sm:flex sm:flex-wrap md:grid">
              {entries.map((entry) => {
                const spanClass = fullRow.has(entry.key) ? "col-span-2" : undefined;
                const buttonClass = cn(
                  entrySizeClass,
                  "px-2 max-[360px]:px-1.5 sm:px-3",
                  spanClass
                );

                if (game.mystery)
                  return (
                    <MysteryEntryButton
                      key={entry.key}
                      gameTitle={game.title}
                      className={buttonClass}
                      announce={announce}
                    />
                  );

                const isClosed = !isWholeGameDisabled && entry.available && !isOpen(entry);
                if (!canEnter(entry) || !entry.path) {
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
                  <Button key={entry.key} asChild variant="outline" className={buttonClass}>
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

        <main className={cn(pageColumnClass, "flex flex-1 flex-col gap-4 pt-5 pb-10 sm:pt-6")}>
          {/* 客户端过旧的提醒落在游戏列表上方：底部那条浮层是网页新版本提醒的位置，
              两条「该更新了」叠在同一处会互相盖掉。壳没装或版本够新时整条不渲染。 */}
          <ClientUpdateNotice />
          {/* 标题行与大厅的「房间列表」同一种写法：标题加一枚等宽计数。 */}
          <div className="flex items-center gap-2">
            <h2 id={gamesHeadingId} className="text-lg font-semibold">
              全部游戏
            </h2>
            <Badge variant="subtle" className="font-mono">
              {GAMES.length}
            </Badge>
          </div>
          {/* 手机一列；`md` 起（平板、横屏手机与桌面）两列，六款游戏排成三行。 */}
          <motion.ul
            aria-labelledby={gamesHeadingId}
            className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4"
            variants={listContainer(GAMES.length)}
            initial="initial"
            animate="animate"
          >
            {GAMES.map((game) => (
              <GameCard key={game.id} game={game} features={features} announce={setMysteryNotice} />
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
