import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  listItem,
  listContainer,
  iconTappable,
  pressable,
  selectable,
  spring,
  useOriginTracker,
} from "@/lib/motion";
import { ArrowRight } from "lucide-react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
// 逐图标引入：品牌图标包的聚合入口无法被摇树，整包会进产物。
import { faQq } from "@fortawesome/free-brands-svg-icons/faQq";
import { faGithub } from "@fortawesome/free-brands-svg-icons/faGithub";
import { faBilibili } from "@fortawesome/free-brands-svg-icons/faBilibili";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  parseChangelogContent,
  resolveLatestVersion,
  sortEntriesByVersion,
  type ChangelogContent,
  type ChangelogEntry,
  type InlineNode,
} from "@/lib/changelog";
// 更新日志与提交历史都在构建期定型，随 JS 产物带 hash 发布。
// 之前放在 public/ 下按固定 URL 取，CDN 的长期缓存会让新内容迟迟不生效。
import changelogData from "@/data/changelog.json";
import commitHistory from "virtual:commit-history";

interface ChangelogData {
  entries: ChangelogEntry[];
}

// JSON 直接 import 时结构由内容推断，这里锚定成契约类型，
// 手写日志漏字段或写错类型在构建期就会报错。
const changelog: ChangelogData = changelogData;

type CommitEntry = (typeof commitHistory.commits)[number];

interface GameEntry {
  id: string;
  path: string;
  icon: string;
  /** 条目主标题 */
  title: string;
  /** 条目副标题；无副标题时省略 */
  subtitle?: string;
  available: boolean;
}

const GAMES: GameEntry[] = [
  {
    id: "whoisfaker",
    path: "/whoisfaker",
    icon: "/assets/Faker.webp",
    title: "Who is Faker",
    available: true,
  },
  {
    id: "songuessr",
    path: "/songuessr",
    icon: "/assets/SongGuessr.webp",
    title: "Songuessr",
    available: true,
  },
  {
    id: "animecharguessr",
    path: "/animecharguessr",
    icon: "/assets/CCB.webp",
    title: "二刺猿笑传之猜猜呗",
    subtitle: "Enhanced Edition",
    available: false,
  },
];

interface ExternalLink {
  href: string;
  label: string;
  icon: IconDefinition;
}

const EXTERNAL_LINKS: ExternalLink[] = [
  { href: "https://qm.qq.com/q/yIoCHg85iK", label: "加入 QQ 群", icon: faQq },
  { href: "https://github.com/Cosmosuperbaka/BakaGame", label: "GitHub 仓库", icon: faGithub },
  { href: "https://space.bilibili.com/354780713", label: "作者哔哩哔哩主页", icon: faBilibili },
];

/**
 * 把时间戳换算成中文相对时间，精度随时间跨度递减：
 * 一分钟内数秒，一小时内数分钟，一天内数小时，再往后数天/月/年。
 *
 * 只有日期没有时间的旧数据（YYYY-MM-DD）按当天零点解析，
 * 这种输入本身没有秒级精度，最细只会落到「几小时前」。
 */
function formatRelativeTime(dateStr: string): string {
  const raw = dateStr.trim();
  // 纯日期缺时区，补零点按本地时间解析，避免被当成 UTC 而偏移一天。
  const then = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw);
  if (Number.isNaN(then.getTime())) return dateStr;

  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);
  // 时钟偏差或未来时间戳，不显示负数。
  if (seconds < 0) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

function GameRow({ game }: { game: GameEntry }) {
  const navigate = useNavigate();
  const [entering, setEntering] = useState(false);

  const baseClass =
    "flex h-full min-h-0 w-full flex-col items-start justify-between gap-2 overflow-hidden rounded-lg border bg-card p-2 text-left sm:gap-3 sm:p-4 [@media(max-height:680px)]:gap-1.5 [@media(max-height:680px)]:p-2";

  const content = (
    <>
      <img
        src={game.icon}
        alt=""
        aria-hidden="true"
        className="h-8 w-8 shrink-0 rounded-md object-cover sm:h-12 sm:w-12 [@media(max-height:680px)]:h-8 [@media(max-height:680px)]:w-8"
      />
      <div className="min-w-0 flex-1">
        <div className="break-words text-sm leading-tight font-semibold sm:text-lg [@media(max-height:680px)]:text-sm">{game.title}</div>
        {game.subtitle ? (
          <div className="mt-1 truncate text-xs text-muted-foreground sm:text-sm [@media(max-width:480px)]:hidden">{game.subtitle}</div>
        ) : null}
      </div>
      {game.available ? (
        <motion.span
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
          animate={{ x: entering ? 8 : 0, color: entering ? "var(--primary)" : undefined }}
          transition={spring.snap}
        >
          <ArrowRight className="h-5 w-5" />
        </motion.span>
      ) : (
        <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
          即将推出
        </Badge>
      )}
    </>
  );

  if (!game.available) {
    return (
      <motion.div data-testid={`game-entry-${game.id}`} variants={listItem}>
        <div aria-disabled="true" className={`${baseClass} opacity-60`}>
          {content}
        </div>
      </motion.div>
    );
  }

  // 点击后先让箭头前移、条目微沉，动效落地再跳转，
  // 使离开当前页读作这次点击的结果而非突然切换。
  const handleEnter = () => {
    if (entering) return;
    setEntering(true);
    window.setTimeout(() => navigate(game.path), 140);
  };

  return (
    <motion.div data-testid={`game-entry-${game.id}`} variants={listItem}>
      <motion.button
        type="button"
        onClick={handleEnter}
        animate={entering ? { scale: 0.99 } : { scale: 1 }}
        {...selectable}
        className={`group ${baseClass} cursor-pointer transition-[background,border-color,box-shadow] duration-150 hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50`}
      >
        {content}
      </motion.button>
    </motion.div>
  );
}

function FooterLink({ link }: { link: ExternalLink }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.a
          href={link.href}
          target="_blank"
          rel="noreferrer"
          aria-label={link.label}
          variants={listItem}
          {...iconTappable}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <FontAwesomeIcon icon={link.icon} className="h-4 w-4" />
        </motion.a>
      </TooltipTrigger>
      <TooltipContent>{link.label}</TooltipContent>
    </Tooltip>
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
              <code key={index} className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">
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
  const blocks = parseChangelogContent(content);

  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      {blocks.map((block, index) =>
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
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatRelativeTime(commit.date)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono select-all">{commit.hash}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{commit.author}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function LandingPage() {
  const [infoOpen, setInfoOpen] = useState(false);
  const { origin, capture } = useOriginTracker();

  // 展示版本号取自更新日志里的最大版本号，与 package.json 无关，
  // 也不依赖 entries 的书写顺序。
  const entries = useMemo(() => sortEntriesByVersion(changelog.entries), []);
  const version = useMemo(() => resolveLatestVersion(entries), [entries]);
  // 整个文件都没有条目时版本号未知，用 ∞ 占位而不是留空。
  const commit = commitHistory.currentCommit;
  const versionLabel = `V${version ?? "∞"}${commit ? `(${commit})` : ""}`;

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-background">
      <header className="px-6 pb-[clamp(0.5rem,3svh,1.75rem)] pt-[clamp(0.75rem,8svh,5rem)] text-center [@media(max-height:680px)]:pb-1 [@media(max-height:680px)]:pt-2">
        <motion.h1
          variants={listItem}
          initial="initial"
          animate="animate"
          className="flex items-center justify-center gap-2 text-4xl font-bold tracking-tight sm:gap-3 sm:text-5xl md:gap-4 md:text-6xl [@media(max-height:680px)]:text-3xl"
        >
          Baka
          <img
            src="/assets/logo.webp"
            alt=""
            aria-hidden="true"
            className="h-12 rounded-md object-cover sm:h-14 md:h-16 [@media(max-height:680px)]:h-9"
          />
          Game
        </motion.h1>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-6xl items-center overflow-hidden px-3 py-2 sm:px-8 [@media(max-height:680px)]:py-1">
        <motion.div
          className="grid h-[clamp(7rem,26svh,11rem)] w-full grid-cols-3 items-stretch gap-2 sm:gap-3"
          variants={listContainer(GAMES.length)}
          initial="initial"
          animate="animate"
        >
          {GAMES.map((game) => (
            <GameRow key={game.id} game={game} />
          ))}
        </motion.div>
      </main>

      <footer className="flex flex-col items-center gap-2 px-6 pb-[clamp(0.5rem,4svh,3rem)] pt-2 [@media(max-height:680px)]:flex-row [@media(max-height:680px)]:justify-center [@media(max-height:680px)]:gap-3 [@media(max-height:680px)]:pb-1 [@media(max-height:680px)]:pt-1">
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
          className="rounded-md px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {versionLabel}
        </motion.button>
      </footer>

      <Dialog open={infoOpen} onOpenChange={setInfoOpen} origin={origin}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{versionLabel}</DialogTitle>
          </DialogHeader>
          <Tabs defaultValue="changelog">
            <TabsList className="w-full">
              <TabsTrigger value="changelog" className="flex-1">更新日志</TabsTrigger>
              <TabsTrigger value="commits" className="flex-1">提交历史</TabsTrigger>
            </TabsList>
            {/* 两份数据都在构建期定型，打开弹窗即可用，不存在加载中状态 */}
            <TabsContent value="changelog" className="scrollbar-hidden mt-4 max-h-[55vh] overflow-y-auto">
              {entries.length > 0 ? (
                <div className="space-y-5">
                  {entries.map((entry) => (
                    <div key={entry.version} className="space-y-2">
                      <div className="flex items-baseline gap-2">
                        <strong className="text-base">V{entry.version}</strong>
                        <span className="text-xs text-muted-foreground">{entry.date}</span>
                      </div>
                      <ChangelogBody content={entry.content} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-6 text-center text-sm text-muted-foreground">暂无更新日志</div>
              )}
            </TabsContent>
            <TabsContent value="commits" className="scrollbar-hidden mt-4 max-h-[55vh] overflow-y-auto pr-1">
              <CommitTimeline commits={commitHistory.commits} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </div>
  );
}
