import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { GitCommitHorizontal, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import faviconUrl from "@/assets/favicon.png";

// ==================== 类型定义 ====================

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
  generatedAt: string;
  currentVersion: string;
  currentCommit: string;
  commits: CommitEntry[];
}

// ==================== 游戏配置 ====================

interface GameConfig {
  id: string;
  path: string;
  icon: string;
  name: string;
  nameEn: string;
  description: string;
  available: boolean;
}

const GAMES: GameConfig[] = [
  {
    id: "whoisfaker",
    path: "/whoisfaker",
    icon: faviconUrl,
    name: "谁是 Faker",
    nameEn: "Who is Faker",
    description: "谁是卧底 · 多人派对社交推理游戏",
    available: true,
  },
  {
    id: "songguessr",
    path: "/songguessr",
    icon: "",
    name: "猜歌",
    nameEn: "SongGuessr",
    description: "听音乐片段，抢答猜歌名",
    available: false,
  },
  {
    id: "animecharguessr",
    path: "/animecharguessr",
    icon: "",
    name: "猜番",
    nameEn: "AnimeCharacterGuessr",
    description: "根据线索猜动漫角色",
    available: false,
  },
];

// ==================== 提交类型色彩映射 ====================

const COMMIT_TYPE_COLORS: Record<string, string> = {
  feat: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  fix: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  docs: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400",
  style: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
  refactor: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  test: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  chore: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  perf: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
};

function getCommitType(message: string): string {
  const match = message.match(/^(\w+)[(:]/);
  return match ? match[1] : "chore";
}

function getCommitTypeColor(type: string): string {
  return COMMIT_TYPE_COLORS[type] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
}

// ==================== 子组件 ====================

function GameCard({ game, index }: { game: GameConfig; index: number }) {
  const navigate = useNavigate();

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      <Card
        className={[
          "relative overflow-hidden transition-[background,border-color,box-shadow] duration-150 h-full",
          game.available
            ? "cursor-pointer hover:bg-primary/5 hover:border-primary/40 hover:shadow-sm"
            : "opacity-55 cursor-not-allowed select-none",
        ].join(" ")}
        onClick={game.available ? () => navigate(game.path) : undefined}
      >
        <CardContent className="p-5 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-3">
              {game.icon ? (
                <img src={game.icon} alt={game.nameEn} className="h-9 w-9 rounded-lg shrink-0" />
              ) : (
                <div className="h-9 w-9 rounded-lg bg-muted shrink-0" />
              )}
              <div className="min-w-0">
                <div className="font-semibold text-base leading-tight">{game.name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{game.nameEn}</div>
              </div>
            </div>
            {game.available ? (
              <Badge variant="default" className="shrink-0 text-xs font-normal">在线</Badge>
            ) : (
              <Badge variant="outline" className="shrink-0 text-xs font-normal text-muted-foreground">
                即将推出
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">{game.description}</p>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function CommitRow({ commit }: { commit: CommitEntry }) {
  const type = getCommitType(commit.message);
  const color = getCommitTypeColor(type);

  return (
    <div className="flex items-start gap-3 py-2.5 border-b last:border-b-0">
      <span className="font-mono text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5 select-all">
        {commit.hash}
      </span>
      <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5 ${color}`}>
        {type}
      </span>
      <span className="text-sm min-w-0 break-words flex-1">{commit.message}</span>
      <span className="text-xs text-muted-foreground shrink-0 mt-0.5">{commit.date}</span>
    </div>
  );
}

// ==================== 主页面 ====================

export default function LandingPage() {
  const [changelog, setChangelog] = useState<ChangelogData | null>(null);
  const [commitHistory, setCommitHistory] = useState<CommitHistoryData | null>(null);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [commitExpanded, setCommitExpanded] = useState(false);

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

  const displayVersion = commitHistory?.currentVersion
    ? `V${commitHistory.currentVersion}(${commitHistory.currentCommit ?? "dev"})`
    : changelog?.currentVersion
      ? `V${changelog.currentVersion}`
      : null;

  const visibleCommits = commitExpanded
    ? (commitHistory?.commits ?? [])
    : (commitHistory?.commits ?? []).slice(0, 5);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* 页头 */}
      <header className="pt-16 md:pt-24 pb-8 md:pb-10 text-center px-6">
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1 className="text-5xl md:text-6xl font-bold tracking-tight flex items-center justify-center gap-4">
            Baka
            <img
              src={faviconUrl}
              alt="BakaGame"
              className="h-14 md:h-16 inline-block rounded-xl"
            />
            Game
          </h1>
          <p className="text-muted-foreground text-base mt-3">多人小游戏合集</p>
        </motion.div>
      </header>

      {/* 游戏卡片区 */}
      <main className="flex-1 w-full max-w-3xl mx-auto px-6 md:px-10 pb-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {GAMES.map((game, i) => (
            <GameCard key={game.id} game={game} index={i} />
          ))}
        </div>
      </main>

      {/* 页脚：版本 + 更新日志 + Commit 历史 */}
      <footer className="w-full max-w-3xl mx-auto px-6 md:px-10 pb-10 space-y-6">
        <div className="border-t pt-6">
          {/* 版本行 */}
          <div className="flex items-center gap-3 mb-4">
            {displayVersion && (
              <span className="text-xs font-mono text-muted-foreground bg-muted px-2 py-1 rounded">
                {displayVersion}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground px-2"
              onClick={() => setChangelogOpen(true)}
            >
              更新日志
            </Button>
          </div>

          {/* Commit 历史 */}
          {commitHistory && commitHistory.commits.length > 0 && (
            <div className="rounded-xl border overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/40 border-b">
                <GitCommitHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">Commit 历史</span>
              </div>
              <div className="px-4 divide-y">
                {visibleCommits.map((commit) => (
                  <CommitRow key={commit.hash} commit={commit} />
                ))}
              </div>
              {(commitHistory.commits.length > 5) && (
                <div className="px-4 py-2 border-t">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full h-7 text-xs text-muted-foreground gap-1"
                    onClick={() => setCommitExpanded((v) => !v)}
                  >
                    {commitExpanded ? (
                      <><ChevronUp className="h-3.5 w-3.5" />收起</>
                    ) : (
                      <><ChevronDown className="h-3.5 w-3.5" />展开全部 {commitHistory.commits.length} 条</>
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </footer>

      {/* 更新日志弹窗 */}
      <Dialog open={changelogOpen} onOpenChange={setChangelogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>更新日志</DialogTitle>
            <DialogDescription>BakaGame 版本历史</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm max-h-[60vh] overflow-y-auto">
            {changelog?.entries.map((entry, idx) => (
              <div key={entry.version} className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <strong className="text-foreground text-base">V{entry.version}</strong>
                  <span className="text-muted-foreground text-xs">{entry.date}</span>
                  <span className="text-muted-foreground">— {entry.title}</span>
                </div>
                <div
                  className="text-muted-foreground [&_ul]:list-disc [&_ul]:list-inside [&_ul]:ml-3 [&_ul]:space-y-0.5 [&_li]:text-sm [&_a]:text-primary [&_a]:underline"
                  dangerouslySetInnerHTML={{ __html: entry.content }}
                />
                {idx < changelog.entries.length - 1 && (
                  <div className="border-t my-3" />
                )}
              </div>
            ))}
            {!changelog && (
              <div className="text-muted-foreground">加载中...</div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
