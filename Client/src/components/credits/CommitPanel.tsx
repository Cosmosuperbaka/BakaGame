import { REPOSITORY_URL } from "@/data/PageMeta";
import { Hint } from "@/components/ui/Tooltip";
import type { CommitEntry } from "@/lib/CommitHistory";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/Time";

/**
 * 提交历史标签：时间线式列表，单条包含提交信息、短哈希、作者与相对时间。
 * 哈希与仓库链接在构建期定型，打开页面即可用，不存在加载中状态。
 */
export function CommitPanel({ commits }: { commits: readonly CommitEntry[] }) {
  if (commits.length === 0) {
    return <div className="py-10 text-center text-sm text-muted-foreground">暂无提交记录</div>;
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
            <Hint label={formatAbsoluteTime(commit.date)}>
              <time
                className="shrink-0 text-xs text-muted-foreground"
                dateTime={commit.date}
                suppressHydrationWarning
              >
                {formatRelativeTime(commit.date)}
              </time>
            </Hint>
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
