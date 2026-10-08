import { useEffect, useRef, useState, useMemo } from "react";
import { animate, motion, useReducedMotion } from "framer-motion";
import {
  flingDockMs,
  jitterShape,
  listItem,
  listContainer,
  iconTappable,
  pressable,
  stepJitterAnimation,
  useOriginTracker,
} from "@/lib/Motion";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/Tooltip";
import {
  parseChangelogEntry,
  resolveLatestVersion,
  sortEntriesByVersion,
  type ChangelogContent,
  type ChangelogEntry,
  type InlineNode,
} from "@/lib/Changelog";
// 更新日志与提交历史都在构建期定型，随 JS 产物带 hash 发布。
// 之前放在 public/ 下按固定 URL 取，CDN 的长期缓存会让新内容迟迟不生效。
import changelogData from "@/data/changelog.json";
import { REPOSITORY_URL } from "@/data/PageMeta";
import commitHistory from "virtual:commit-history";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/Time";
import { cn } from "@/lib/Utils";

interface ChangelogData {
  entries: ChangelogEntry[];
}

// JSON 直接 import 时结构由内容推断，这里锚定成契约类型，
// 手写日志漏字段或写错类型在构建期就会报错。
const changelog: ChangelogData = changelogData;

type CommitEntry = (typeof commitHistory.commits)[number];

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

/**
 * CCB 增强版的主页入口在生产部署临时下线。
 *
 * 生产构建（`npm run build`，含 Makers 平台侧构建）只把该条目渲染成「即将上线」的
 * 不可用卡片；本地 `npm run dev` 保持开放，便于联调。这里只拦主页入口——
 * `/ccb` 大厅与 `/ccb/room/<房号>` 直链照常进入，服务端不做任何拦截。
 *
 * 恢复上线：把 `isCcbHomeEntryAvailable` 改回 `() => true`（或删除该开关与调用点）。
 */
const isCcbHomeEntryAvailable = () => import.meta.env.DEV;

/** 主页游戏条目。入口开关在组件首次渲染时读取，测试可用 `vi.stubEnv("DEV", …)` 覆盖。 */
function resolveGames(): GameEntry[] {
  return [
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
      path: "/ccb",
      lobbyPath: "/ccb",
      icon: "/assets/CCB.jpg",
      title: "二刺猿笑传之猜猜呗",
      subtitle: "Enhanced Edition",
      available: isCcbHomeEntryAvailable(),
      subModes: [
        {
          id: "multiplayer",
          title: "多人模式",
          path: "/ccb",
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
}

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
    navigate(targetPath);
  };

  // 卡片容器本身不可点（入口是里面的按钮），悬停描边只留给可用的卡片，读作「这一张能进」；未上线的卡片不响应悬停。
  const cardContainerClass = cn(
    "flex h-full min-h-0 w-full flex-col justify-between gap-2.5 sm:gap-3 overflow-hidden rounded-md border bg-card p-3 sm:p-3.5 text-left shadow-2xs transition-colors [@media(max-height:680px)]:gap-1.5 [@media(max-height:680px)]:p-2",
    game.available && "hover:border-primary/40",
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

  // 包含子模式入口的游戏（如 Songuessr 与 CCB）
  const isWholeGameDisabled = !game.available;
  const subModeCount = game.subModes.length;

  return (
    <motion.div data-testid={`game-entry-${game.id}`} variants={listItem} className="h-full">
      <div
        aria-disabled={isWholeGameDisabled ? "true" : undefined}
        className={cardContainerClass}
      >
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
        // 与文字同色（Design §3：并排图标不单独调淡），悬停时朝外链方向挪一点。
        className="h-3 w-3 shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
      />
    </motion.a>
  );
}

function InlineContent({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case "strong":
            return (
              <strong key={index} className="font-semibold text-foreground">
                {node.text}
              </strong>
            );
          case "code":
            return (
              <code key={index} className="rounded-md bg-muted px-1 py-0.5 font-mono text-xs">
                {node.text}
              </code>
            );
          case "link":
            return (
              <a
                key={index}
                href={node.href}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2"
              >
                {node.text}
              </a>
            );
          default:
            return <span key={index}>{node.text}</span>;
        }
      })}
    </>
  );
}

function ChangelogBody({ content }: { content: ChangelogContent }) {
  const sections = parseChangelogEntry(content);

  if (sections.length === 0) {
    return <div className="py-2 text-sm text-muted-foreground">暂无详细说明</div>;
  }

  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <div key={section.type} className="space-y-1.5" data-testid={`changelog-category-${section.type}`}>
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" size="xs" className="font-mono lowercase">
              {section.type}
            </Badge>
            <span className="text-xs font-semibold text-foreground">{section.label}</span>
          </div>
          <div className="space-y-1 text-sm text-muted-foreground pl-0.5">
            {section.blocks.map((block, index) =>
              block.kind === "list" ? (
                <ul key={index} className="ml-4 list-outside list-disc space-y-1">
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex} className="pl-0.5">
                      <InlineContent nodes={item} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p key={index}>
                  <InlineContent nodes={block.content} />
                </p>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function CommitTimeline({ commits }: { commits: CommitEntry[] }) {
  if (commits.length === 0) {
    return <div className="py-6 text-center text-sm text-muted-foreground">暂无提交记录</div>;
  }

  return (
    <ol className="relative ml-1 border-l">
      {commits.map((commit) => (
        <li key={commit.hash} className="relative pb-4 pl-5 last:pb-0">
          <span
            aria-hidden="true"
            className="absolute top-1.5 -left-[4.5px] h-2 w-2 rounded-full bg-border"
          />
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 text-sm break-words">{commit.message}</span>
            {/* 相对时间说不出是哪一天，悬停给出确切时刻，用于判断自己是不是旧版本 */}
            <time
              className="shrink-0 text-xs text-muted-foreground"
              dateTime={commit.date}
              title={formatAbsoluteTime(commit.date)}
              suppressHydrationWarning
            >
              {formatRelativeTime(commit.date)}
            </time>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            {/* 哈希即入口：点进去是这次提交在仓库里的完整改动 */}
            <a
              href={`${REPOSITORY_URL}/commit/${commit.hash}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono transition-colors hover:text-foreground"
            >
              {commit.hash}
            </a>
            <span aria-hidden="true">·</span>
            <span className="truncate">{commit.author}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 版本信息弹窗的面板：两个标签同一固定高度，内部滚动。 */
const INFO_PANEL = "scrollbar-hidden h-[min(58vh,34rem)] overflow-y-auto overscroll-contain";

export default function LandingPage() {
  const [infoOpen, setInfoOpen] = useState(false);
  const { origin, capture } = useOriginTracker();
  const versionRef = useRef<HTMLSpanElement>(null);
  const reducedMotion = useReducedMotion();
  const [docking, setDocking] = useState(0);
  // 弹窗被吸回版本号的那一刻，号码被撞得逐格抖一下（定格阶梯抖动），读作窗口真的收进了按钮里。
  useEffect(() => {
    if (!docking || reducedMotion) return;
    let stop: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      const node = versionRef.current;
      if (!node) return;
      const { keyframes, transition } = stepJitterAnimation(jitterShape.versionDock);
      stop = animate(node, keyframes, transition).stop;
    }, flingDockMs);
    return () => {
      window.clearTimeout(timer);
      stop?.();
    };
  }, [docking, reducedMotion]);
  const changeInfoOpen = (open: boolean) => {
    setInfoOpen(open);
    if (!open) setDocking((count) => count + 1);
  };
  // 入口可用性随构建模式变化，首次渲染时读一次；测试用 `vi.stubEnv("DEV", …)` 覆盖。
  const games = useMemo(() => resolveGames(), []);

  // 展示版本号取自更新日志里的最大版本号，与 package.json 无关，
  // 也不依赖 entries 的书写顺序。
  const entries = useMemo(() => sortEntriesByVersion(changelog.entries), []);
  const version = useMemo(() => resolveLatestVersion(entries), [entries]);
  // 整个文件都没有条目时版本号未知，用 ∞ 占位而不是留空。
  const commit = commitHistory.currentCommit;
  const versionLabel = `V${version ?? "∞"}${commit ? `(${commit})` : ""}`;
  // 弹窗标题只写「版本信息」，版本号与提交哈希放在描述里，读屏打开弹窗时一并读出。
  const versionDescription = `V${version ?? "∞"}${commit ? ` · ${commit}` : ""}`;

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
      <Seo path="/" />
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
          variants={listContainer(games.length)}
          initial="initial"
          animate="animate"
        >
          {games.map((game) => (
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
          <span className="mr-0.5 text-muted-foreground select-none">友情链接</span>
          {FRIEND_LINKS.map((link) => (
            <FriendLinkItem key={link.href} link={link} />
          ))}
        </motion.div>

        {/* 社区外链与版本详情 */}
        <div className="flex items-center gap-2">
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
            onClick={(event) => {
              capture(event);
              setInfoOpen(true);
            }}
            className="min-h-8 rounded-md px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <span ref={versionRef} className="inline-block">{versionLabel}</span>
          </motion.button>
        </div>
      </footer>

      <Dialog open={infoOpen} onOpenChange={changeInfoOpen} origin={origin} fling>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>版本信息</DialogTitle>
            <DialogDescription className="font-mono">{versionDescription}</DialogDescription>
          </DialogHeader>
          {/* 窗口带着动量从版本号里抛出来、关上时吸回去；切标签时两幅内容整幅推过去 */}
          <Tabs defaultValue="changelog">
            <TabsList className="mb-4 w-full">
              <TabsTrigger value="changelog" className="flex-1">更新日志</TabsTrigger>
              <TabsTrigger value="commits" className="flex-1">提交历史</TabsTrigger>
            </TabsList>
            {/* 两份数据都在构建期定型（提交历史取自 GitHub 接口，取不到时降级为本地 git 历史），
                打开弹窗即可用，不存在加载中状态。
                两个面板同高：切换标签时弹窗不跟着伸缩，内容在原地整幅推过去。 */}
            <TabsContent value="changelog" className={INFO_PANEL}>
              {entries.length > 0 ? (
                <ol className="space-y-6">
                  {entries.map((entry) => (
                    <li key={entry.version} className="grid gap-2 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-4">
                      {/* 宽屏版本号在左栏随滚动吸顶，读完一段长日志仍知道是哪个版本 */}
                      <div className="flex items-baseline gap-2 sm:sticky sm:top-0 sm:flex-col sm:gap-0.5 sm:self-start">
                        <strong className="text-base">V{entry.version}</strong>
                        <span className="text-xs text-muted-foreground">{entry.date}</span>
                      </div>
                      <ChangelogBody content={entry.content} />
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="py-6 text-center text-sm text-muted-foreground">暂无更新日志</div>
              )}
            </TabsContent>
            <TabsContent value="commits" className={cn(INFO_PANEL, "pr-1")}>
              <CommitTimeline commits={commitHistory.commits} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </div>
  );
}
