import { useState } from "react";
import { motion } from "framer-motion";
import { listItem, listContainer, iconTappable, pressable } from "@/lib/Motion";
import { usePageNavigate, useSharedElementName } from "@/hooks/UsePageTransition";
import { ArrowUpRight } from "lucide-react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
// 逐图标引入：品牌图标包的聚合入口无法被摇树，整包会进产物。
import { faQq } from "@fortawesome/free-brands-svg-icons/faQq";
import { faGithub } from "@fortawesome/free-brands-svg-icons/faGithub";
import { faBilibili } from "@fortawesome/free-brands-svg-icons/faBilibili";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Seo } from "@/components/common/Seo";
import { AccountButton, AccountDialogs, FeedbackButton } from "@/components/account/AccountEntry";
import { ClientUpdateNotice } from "@/components/ClientUpdateNotice";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/Tooltip";
import { ClientDownloadEntry } from "@/components/ClientDownloadEntry";
// 展示版本号构建期从 changelog.json 解析（与致谢页同一真相源），整份日志不随首屏下载。
import appVersion from "virtual:app-version";
import commitHistory from "virtual:commit-history";
import { REPOSITORY_URL } from "@/data/PageMeta";
import { cn } from "@/lib/Utils";

interface GameSubMode {
  id: string;
  title: string;
  path?: string;
  available: boolean;
}

interface GameEntry {
  id: string;
  path?: string;
  /** 该游戏大厅的路径：卡片标题与大厅顶栏的游戏名是同一个跨页共享元素；未上线的游戏省略 */
  lobbyPath?: string;
  icon: string;
  /** 条目主标题 */
  title: string;
  /** 条目副标题；无副标题时省略 */
  subtitle?: string;
  available: boolean;
  subModes?: GameSubMode[];
}

const GAMES: GameEntry[] = [
  {
    id: "whoisfaker",
    path: "/whoisfaker",
    lobbyPath: "/whoisfaker",
    icon: "/assets/Faker.png",
    title: "Who is Faker",
    available: true,
  },
  {
    id: "songuessr",
    lobbyPath: "/songuessr",
    icon: "/assets/SongGuessr.gif",
    title: "Songuessr",
    available: true,
    subModes: [
      {
        id: "singleplayer",
        title: "单人模式",
        path: "/songuessr/solo",
        available: true,
      },
      {
        id: "multiplayer",
        title: "多人模式",
        path: "/songuessr",
        available: true,
      },
    ],
  },
  {
    id: "animecharguessr",
    path: "/cee",
    lobbyPath: "/cee",
    icon: "/assets/CEE.jpg",
    title: "二刺猿笑传之猜猜呗",
    subtitle: "Enhanced Edition",
    available: true,
    subModes: [
      {
        id: "multiplayer",
        title: "多人模式",
        path: "/cee",
        available: true,
      },
      {
        id: "ranked",
        title: "排位赛",
        available: false,
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
  icon: IconDefinition;
}

const EXTERNAL_LINKS: ExternalLink[] = [
  { href: "https://qm.qq.com/q/yIoCHg85iK", label: "加入 QQ 群", icon: faQq },
  { href: REPOSITORY_URL, label: "GitHub 仓库", icon: faGithub },
  { href: "https://space.bilibili.com/354780713", label: "作者哔哩哔哩主页", icon: faBilibili },
];

const LEGAL_LINKS = [
  { href: "/privacy", label: "隐私说明" },
  { href: "/terms", label: "用户条款" },
] as const;

function ComingSoonBadge() {
  return (
    <Badge variant="upcoming" size="xs" className="shrink-0 select-none">
      即将上线
    </Badge>
  );
}

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
          className="w-fit max-w-full text-sm sm:text-base font-semibold truncate whitespace-nowrap"
          style={{ viewTransitionName: sharedName }}
        >
          {game.title}
        </div>
        {game.subtitle ? (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{game.subtitle}</div>
        ) : null}
      </div>
    </div>
  );
}

function GameRow({ game }: { game: GameEntry }) {
  const navigate = usePageNavigate();
  // 只用来挡住重复点击：分块还在加载时旧页仍可点，第二次点击会往历史里再压一条同样的记录。
  const [enteringPath, setEnteringPath] = useState<string | null>(null);

  // 立即导航：旧页连同按下的按钮一起定格成过渡快照向前退出，离开当前页读作这次点击的结果。
  const handleEnter = (targetPath?: string) => {
    if (!targetPath || enteringPath) return;
    setEnteringPath(targetPath);
    void navigate(targetPath);
  };

  // 卡片容器本身不可点（入口是里面的按钮），悬停描边只留给可用的卡片，读作「这一张能进」；未上线的卡片不响应悬停。
  const cardContainerClass = cn(
    "flex h-full min-h-0 w-full flex-col justify-between gap-2.5 sm:gap-3 overflow-hidden rounded-md border bg-card p-3 sm:p-3.5 text-left shadow-2xs transition-colors [@media(max-height:680px)]:gap-1.5 [@media(max-height:680px)]:p-2",
    game.available && "hover:border-primary/40"
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
            <Button
              variant="outline"
              size="sm"
              aria-label={`${game.title} 开始游戏`}
              onClick={() => handleEnter(game.path)}
              className="h-8 w-full text-xs sm:text-sm font-medium"
            >
              开始游戏
            </Button>
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
            const isModeAvailable = !isWholeGameDisabled && mode.available;
            // 三个子模式在窄屏排成两行，首项独占一行：三等分时每格不到 110px，放不下模式名加「即将上线」。
            const spanClass = subModeCount === 3 && index === 0 ? "max-sm:col-span-2" : "";

            if (!isModeAvailable) {
              return (
                <div
                  key={mode.id}
                  aria-disabled="true"
                  className={`flex h-8 items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-muted/40 px-1.5 text-center text-xs text-muted-foreground select-none ${spanClass}`}
                >
                  <span className="truncate">{mode.title}</span>
                  {!isWholeGameDisabled && <ComingSoonBadge />}
                </div>
              );
            }

            return (
              <Button
                key={mode.id}
                variant="outline"
                size="sm"
                aria-label={`${game.title} ${mode.title}`}
                onClick={() => handleEnter(mode.path)}
                className={`h-8 w-full px-2.5 text-xs sm:text-sm font-medium ${spanClass}`}
              >
                <span className="truncate">{mode.title}</span>
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
        <Button asChild variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
          <motion.a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            aria-label={link.label}
            variants={listItem}
            {...iconTappable}
          >
            {/* Font Awesome 的内置样式不进层叠层，按 em 定尺寸并压过 w-4 这类工具类，尺寸只能经字号给。 */}
            <FontAwesomeIcon icon={link.icon} className="text-base" />
          </motion.a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{link.label}</TooltipContent>
    </Tooltip>
  );
}

/** 站内法务页入口：与版本号同一种文本按钮，悬停下划线告知这是跳转。 */
function FooterPageLink({ href, label }: { href: string; label: string }) {
  const navigate = usePageNavigate();
  return (
    <motion.a
      href={href}
      {...pressable}
      onClick={(event) => {
        event.preventDefault();
        void navigate(href);
      }}
      className="min-h-8 rounded-md px-2 py-1 text-xs text-muted-foreground underline-offset-4 transition-colors hover:bg-accent hover:text-accent-foreground hover:underline"
    >
      {label}
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

/** 版本号入口：打开统一的版本信息页（更新日志 / 提交历史 / 开源致谢三个标签）。 */
const VERSION_PAGE_PATH = "/credits?tab=changelog";

export default function LandingPage() {
  const navigate = usePageNavigate();

  // 展示版本号取自更新日志里的最大版本号，与 package.json 无关；
  // 解析在构建期完成，运行时不再为了一个字符串背下整份日志。
  const version = appVersion || undefined;
  const commit = commitHistory.currentCommit;
  // 日志为空时版本号未知，用 ∞ 占位而不是留空。
  const versionLabel = `V${version ?? "∞"}${commit ? `(${commit})` : ""}`;

  return (
    <div className="relative grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
      <Seo path="/" />
      {/* 右上角这一排：下载客户端在账号左边，浮着不占页头的纵向空间；账号系统未启用时只剩下载，
          在客户端里下载入口自己让位，只剩账号。 */}
      <div className="absolute right-3 top-3 z-panel flex items-center gap-1 sm:right-5 sm:top-4">
        <ClientDownloadEntry />
        <AccountButton />
      </div>
      <header className="px-6 pb-[clamp(0.5rem,3svh,1.75rem)] pt-[clamp(0.75rem,8svh,5rem)] text-center [@media(max-height:680px)]:pb-1 [@media(max-height:680px)]:pt-2">
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
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-xl overflow-y-auto sm:overflow-hidden px-4 py-2 sm:px-6 [@media(max-height:680px)]:py-1">
        {/* 纵向居中交给子元素的 my-auto，而不是父级的 items-center：
            父级在内容超出容器时会把内容向上下两侧同时溢出，顶部那部分越过 header 且滚不回来；
            auto 边距在有空间时居中、空间不足时归零，矮屏下自然退化为顶部对齐。 */}
        <motion.div
          className="my-auto flex w-full flex-col gap-2.5 sm:gap-3"
          variants={listContainer(GAMES.length)}
          initial="initial"
          animate="animate"
        >
          {/* 客户端过旧的提醒落在游戏列表上方：底部那条浮层是网页新版本提醒的位置，
              两条「该更新了」叠在同一处会互相盖掉。壳没装或版本够新时整条不渲染。 */}
          <ClientUpdateNotice />
          {GAMES.map((game) => (
            <GameRow key={game.id} game={game} />
          ))}
        </motion.div>
      </main>

      <footer className="flex flex-col items-center gap-2 px-6 pb-[clamp(0.5rem,4svh,3rem)] pt-2 [@media(max-height:680px)]:flex-row [@media(max-height:680px)]:flex-wrap [@media(max-height:680px)]:justify-center [@media(max-height:680px)]:gap-x-4 [@media(max-height:680px)]:gap-y-1 [@media(max-height:680px)]:pb-1 [@media(max-height:680px)]:pt-1">
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
          <motion.button
            type="button"
            {...pressable}
            onClick={() => void navigate(VERSION_PAGE_PATH)}
            className="min-h-8 rounded-md px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {versionLabel}
          </motion.button>
          <FeedbackButton />
          {LEGAL_LINKS.map((link) => (
            <FooterPageLink key={link.href} href={link.href} label={link.label} />
          ))}
        </div>
      </footer>

      <AccountDialogs />
    </div>
  );
}
