import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import faviconUrl from "@/assets/favicon.png";

interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  content: string;
}

interface ChangelogData {
  currentVersion: string;
  entries: ChangelogEntry[];
}

interface CommitEntry {
  hash: string;
  message: string;
  date: string;
  author: string;
}

interface CommitHistoryData {
  currentVersion: string;
  currentCommit: string;
  commits: CommitEntry[];
}

interface GameEntry {
  id: string;
  path: string;
  icon: string;
  name: string;
  nameEn: string;
  available: boolean;
}

const GAMES: GameEntry[] = [
  {
    id: "whoisfaker",
    path: "/whoisfaker",
    icon: faviconUrl,
    name: "谁是 Faker",
    nameEn: "WhoIsFaker",
    available: true,
  },
  {
    id: "songguessr",
    path: "/songguessr",
    icon: "",
    name: "猜歌",
    nameEn: "SongGuessr",
    available: false,
  },
  {
    id: "animecharguessr",
    path: "/animecharguessr",
    icon: "",
    name: "猜角色",
    nameEn: "AnimeCharacterGuessr",
    available: false,
  },
];

// 把日期换算成中文相对时间
function formatRelativeTime(dateStr: string): string {
  const then = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(then.getTime())) return dateStr;
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

function GameRow({ game, index }: { game: GameEntry; index: number }) {
  const navigate = useNavigate();
  const baseClass =
    "w-full flex items-center gap-5 rounded-xl border bg-card px-5 py-6 md:px-6 md:py-7 text-left";

  const content = (
    <>
      {game.icon ? (
        <img
          src={game.icon}
          alt=""
          aria-hidden="true"
          className="h-14 w-14 shrink-0 rounded-lg md:h-16 md:w-16"
        />
      ) : (
        <div className="h-14 w-14 shrink-0 rounded-lg bg-muted md:h-16 md:w-16" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xl font-semibold md:text-2xl">{game.name}</div>
        <div className="mt-1 truncate text-sm text-muted-foreground">{game.nameEn}</div>
      </div>
      {game.available ? (
        <ArrowRight className="h-5 w-5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
      ) : (
        <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
          即将推出
        </Badge>
      )}
    </>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      {game.available ? (
        <button
          type="button"
          onClick={() => navigate(game.path)}
          className={`group ${baseClass} cursor-pointer transition-[background,border-color,box-shadow] duration-150 hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]`}
        >
          {content}
        </button>
      ) : (
        <div aria-disabled="true" className={`${baseClass} opacity-60`}>
          {content}
        </div>
      )}
    </motion.div>
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
  const [changelog, setChangelog] = useState<ChangelogData | null>(null);
  const [commitHistory, setCommitHistory] = useState<CommitHistoryData | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  useEffect(() => {
    fetch("/changelog.json")
      .then((r) => r.json())
      .then((data: ChangelogData) => setChangelog(data))
      .catch(() => {});

    fetch("/commit-history.json")
      .then((r) => r.json())
      .then((data: CommitHistoryData) => setCommitHistory(data))
      .catch(() => {});
  }, []);

  const version = commitHistory?.currentVersion ?? changelog?.currentVersion;
  const commit = commitHistory?.currentCommit;
  const versionLabel = version
    ? `V${version}${commit ? `(${commit})` : ""}`
    : null;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="px-6 pt-20 pb-10 text-center md:pt-28 md:pb-12">
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1 className="flex items-center justify-center gap-4 text-5xl font-bold tracking-tight md:text-6xl">
            Baka
            <img src={faviconUrl} alt="" aria-hidden="true" className="h-14 rounded-xl md:h-16" />
            Game
          </h1>
          <p className="mt-3 text-base text-muted-foreground">多人小游戏合集</p>
        </motion.div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-6 pb-12 md:px-10">
        <div className="space-y-3">
          {GAMES.map((game, i) => (
            <GameRow key={game.id} game={game} index={i} />
          ))}
        </div>
      </main>

      <footer className="flex justify-center px-6 pb-10">
        {versionLabel && (
          <button
            type="button"
            onClick={() => setInfoOpen(true)}
            className="rounded-md px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]"
          >
            {versionLabel}
          </button>
        )}
      </footer>

      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{versionLabel ?? "版本信息"}</DialogTitle>
            <DialogDescription>更新日志与提交历史</DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="changelog">
            <TabsList className="w-full">
              <TabsTrigger value="changelog" className="flex-1">更新日志</TabsTrigger>
              <TabsTrigger value="commits" className="flex-1">提交历史</TabsTrigger>
            </TabsList>
            <TabsContent value="changelog" className="mt-4 max-h-[55vh] overflow-y-auto">
              {changelog ? (
                <div className="space-y-5">
                  {changelog.entries.map((entry) => (
                    <div key={entry.version} className="space-y-2">
                      <div className="flex items-baseline gap-2">
                        <strong className="text-base">V{entry.version}</strong>
                        <span className="text-xs text-muted-foreground">{entry.date}</span>
                        <span className="min-w-0 truncate text-sm text-muted-foreground">
                          {entry.title}
                        </span>
                      </div>
                      <div
                        className="text-sm text-muted-foreground [&_a]:text-primary [&_a]:underline [&_li]:text-sm [&_ul]:ml-3 [&_ul]:list-inside [&_ul]:list-disc [&_ul]:space-y-0.5"
                        dangerouslySetInnerHTML={{ __html: entry.content }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-6 text-center text-sm text-muted-foreground">加载中...</div>
              )}
            </TabsContent>
            <TabsContent value="commits" className="mt-4 max-h-[55vh] overflow-y-auto pr-1">
              {commitHistory ? (
                <CommitTimeline commits={commitHistory.commits} />
              ) : (
                <div className="py-6 text-center text-sm text-muted-foreground">加载中...</div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </div>
  );
}
