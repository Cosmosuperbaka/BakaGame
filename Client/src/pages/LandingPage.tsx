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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  parseChangelogContent,
  resolveLatestVersion,
  sortEntriesByVersion,
  type ChangelogContent,
  type ChangelogEntry,
  type InlineNode,
} from "@/lib/changelog";
// 更新日志在构建期随 JS 产物发布，避免 public/ 固定 URL 的长期缓存问题。
import changelogData from "@/data/changelog.json";

interface ChangelogData {
  entries: ChangelogEntry[];
}

// JSON 直接 import 时结构由内容推断，这里锚定成契约类型，
// 手写日志漏字段或写错类型在构建期就会报错。
const changelog: ChangelogData = changelogData;

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
    icon: "/assets/Faker.png",
    title: "Who is Faker",
    available: true,
  },
  {
    id: "songguessr",
    path: "/songguessr",
    icon: "/assets/SongGuessr.gif",
    title: "Song Guessr",
    available: false,
  },
  {
    id: "animecharguessr",
    path: "/animecharguessr",
    icon: "/assets/CCB.jpg",
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

function GameRow({ game }: { game: GameEntry }) {
  const navigate = useNavigate();
  const [entering, setEntering] = useState(false);

  const baseClass =
    "w-full flex items-center gap-5 rounded-xl border bg-card px-5 py-6 md:px-6 md:py-7 text-left";

  const content = (
    <>
      <img
        src={game.icon}
        alt=""
        aria-hidden="true"
        className="h-14 w-14 shrink-0 rounded-md object-cover md:h-16 md:w-16"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xl font-semibold md:text-2xl">{game.title}</div>
        {game.subtitle ? (
          <div className="mt-1 truncate text-sm text-muted-foreground">{game.subtitle}</div>
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
      <motion.div variants={listItem}>
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
    <motion.div variants={listItem}>
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

export default function LandingPage() {
  const [infoOpen, setInfoOpen] = useState(false);
  const { origin, capture } = useOriginTracker();

  // 展示版本号取自更新日志里的最大版本号，与 package.json 无关，
  // 也不依赖 entries 的书写顺序。
  const entries = useMemo(() => sortEntriesByVersion(changelog.entries), []);
  const version = useMemo(() => resolveLatestVersion(entries), [entries]);
  const versionLabel = `V${version ?? "∞"}`;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="px-6 pb-10 pt-20 text-center md:pb-12 md:pt-28">
        <motion.h1
          variants={listItem}
          initial="initial"
          animate="animate"
          className="flex items-center justify-center gap-4 text-5xl font-bold tracking-tight md:text-6xl"
        >
          Baka
          <img
            src="/assets/logo.gif"
            alt=""
            aria-hidden="true"
            className="h-14 rounded-md object-cover md:h-16"
          />
          Game
        </motion.h1>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-6 pb-12 md:px-10">
        <motion.div
          className="space-y-3"
          variants={listContainer(GAMES.length)}
          initial="initial"
          animate="animate"
        >
          {GAMES.map((game) => (
            <GameRow key={game.id} game={game} />
          ))}
        </motion.div>
      </main>

      <footer className="flex flex-col items-center gap-3 px-6 pb-10">
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
          <div className="mt-4 max-h-[55vh] overflow-y-auto">
              {entries.length > 0 ? (
                <div className="space-y-5">
                  {entries.map((entry) => (
                    <div key={entry.version} className="space-y-2">
                      <div className="flex items-baseline gap-2">
                        <strong className="text-base">V{entry.version}</strong>
                        <span className="text-xs text-muted-foreground">{entry.date}</span>
                        <span className="min-w-0 truncate text-sm text-muted-foreground">
                          {entry.title}
                        </span>
                      </div>
                      <ChangelogBody content={entry.content} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-6 text-center text-sm text-muted-foreground">暂无更新日志</div>
              )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
