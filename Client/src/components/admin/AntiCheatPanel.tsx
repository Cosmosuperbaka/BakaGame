import { useState } from "react";
import type { AdminAntiCheatReview, AntiCheatReviewStatus } from "@/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { SettingSelect } from "@/components/common/room/SettingFields";
import {
  AdminTable,
  AdminToolbar,
  Pager,
  QueryState,
  RowButton,
  UserCell,
} from "@/components/admin/AdminParts";
import { useAdminAction, useAdminQuery } from "@/hooks/UseAdminQuery";
import { api } from "@/lib/Api";
import { formatDateTime, formatShortDateTime } from "@/lib/AdminFormat";
import {
  ANTI_CHEAT_REVIEW_ACTION_LABELS,
  ANTI_CHEAT_REVIEW_BADGE,
  ANTI_CHEAT_REVIEW_LABELS,
  CEE_CLIENT_TYPE_LABELS,
} from "@/lib/AntiCheatCopy";

const LIMIT = 20;
const STATUS_VALUES = Object.keys(ANTI_CHEAT_REVIEW_LABELS) as AntiCheatReviewStatus[];
const STATUS_OPTIONS = STATUS_VALUES.map((status) => ({
  value: status,
  label: ANTI_CHEAT_REVIEW_LABELS[status],
}));
const STATUS_FILTER = [{ value: "", label: "全部状态" }, ...STATUS_OPTIONS];

/** 间隔序列只展示前 8 个：一回合的猜测次数本就有限，超长时以计数收尾。 */
const intervalText = (intervals: number[]) => {
  const shown = intervals.slice(0, 8).map((ms) => `${Math.round(ms / 100) / 10}s`);
  return intervals.length > 8
    ? `${shown.join(" · ")} 等 ${intervals.length} 段`
    : shown.join(" · ");
};

function ReviewDetail({ item, onChanged }: { item: AdminAntiCheatReview; onChanged: () => void }) {
  const action = useAdminAction();
  const change = (next: AntiCheatReviewStatus) => {
    void action.run(
      next,
      async () => {
        await api.admin.antiCheat.setStatus({ id: item.id, status: next });
        onChanged();
      },
      "处置失败，请稍后重试"
    );
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={ANTI_CHEAT_REVIEW_BADGE[item.status]} size="xs">
          {ANTI_CHEAT_REVIEW_LABELS[item.status]}
        </Badge>
        <UserCell user={item.player} />
        <span className="font-mono text-xs text-muted-foreground">房间 {item.roomId}</span>
        <span className="text-muted-foreground">第 {item.roundNumber} 回合</span>
        <span className="text-muted-foreground">{CEE_CLIENT_TYPE_LABELS[item.clientType]}</span>
        <span className="text-muted-foreground">记录于 {formatDateTime(item.createdAt)}</span>
      </div>
      <p className="text-sm text-muted-foreground">
        条目是「值得看一眼」的候选，不是结论；分值只决定它进不进队列，处置完全由这里决定。
      </p>
      <section aria-label="命中依据" className="grid gap-1.5">
        <h3 className="text-sm font-medium">命中依据（分值 {item.score}）</h3>
        <ul className="grid gap-1 text-sm">
          {item.reasons.map((reason) => (
            <li key={reason} className="rounded-md border bg-card px-3 py-2">
              {reason}
            </li>
          ))}
        </ul>
      </section>
      <dl className="grid gap-1 text-xs text-muted-foreground">
        <div>
          <dt className="inline">猜测次数：</dt>
          <dd className="inline font-mono">
            {item.features.guesses}（其中未检索直接猜 {item.features.noSearchGuesses} 次）
          </dd>
        </div>
        <div>
          <dt className="inline">间隔变异系数：</dt>
          <dd className="inline font-mono">
            {item.features.cv === null ? "样本不足" : item.features.cv.toFixed(3)}
          </dd>
        </div>
        <div>
          <dt className="inline">相邻间隔：</dt>
          <dd className="inline break-all font-mono">{intervalText(item.features.intervals)}</dd>
        </div>
        <div>
          <dt className="inline">首猜即中：</dt>
          <dd className="inline font-mono">{item.features.firstGuessCorrect ? "是" : "否"}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        {(["cleared", "actioned", "open"] as const)
          .filter((next) => next !== item.status)
          .map((next) => (
            <Button
              key={next}
              type="button"
              variant={next === "open" ? "ghost" : "outline"}
              size="sm"
              disabled={action.busy !== null}
              loading={action.busy === next}
              onClick={() => change(next)}
            >
              {ANTI_CHEAT_REVIEW_ACTION_LABELS[next]}
            </Button>
          ))}
      </div>
      {action.error ? (
        <p role="alert" className="text-sm text-destructive">
          {action.error}
        </p>
      ) : null}
    </div>
  );
}

export function AntiCheatPanel() {
  const [status, setStatus] = useState("open");
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const input = {
    ...(status ? { status: status as AntiCheatReviewStatus } : {}),
    limit: LIMIT,
    offset,
  };
  const list = useAdminQuery(
    `anticheat:${JSON.stringify(input)}`,
    () => api.admin.antiCheat.list(input),
    "复核队列加载失败"
  );
  const items = list.data?.items ?? [];
  const detail = items.find((item) => item.id === openId) ?? null;

  return (
    <div>
      <AdminToolbar
        title="反作弊复核"
        count={list.data?.total ?? null}
        onReload={list.reload}
        loading={list.loading && Boolean(list.data)}
      >
        <div className="w-32">
          <SettingSelect
            label="状态"
            value={status}
            options={STATUS_FILTER}
            onChange={(value) => {
              setStatus(value);
              setOffset(0);
            }}
          />
        </div>
      </AdminToolbar>
      <QueryState
        loading={list.loading}
        error={list.error}
        empty={Boolean(list.data) && !items.length}
        hasData={Boolean(list.data)}
        onRetry={list.reload}
        emptyText="没有待复核的条目"
      />
      {items.length ? (
        <AdminTable label="复核队列">
          <thead>
            <tr>
              <th scope="col">玩家</th>
              <th scope="col">房间 · 回合</th>
              <th scope="col">客户端</th>
              <th scope="col">分值</th>
              <th scope="col">依据</th>
              <th scope="col">状态</th>
              <th scope="col">记录时间</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <RowButton onClick={() => setOpenId(item.id)}>
                    <span className="block truncate">{item.playerName}</span>
                  </RowButton>
                </td>
                <td className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {item.roomId} · {item.roundNumber}
                </td>
                <td>{CEE_CLIENT_TYPE_LABELS[item.clientType]}</td>
                <td className="tabular-nums">{item.score}</td>
                <td className="max-w-72">
                  <span className="block truncate text-muted-foreground">
                    {item.reasons.join("；")}
                  </span>
                </td>
                <td>
                  <Badge variant={ANTI_CHEAT_REVIEW_BADGE[item.status]} size="xs">
                    {ANTI_CHEAT_REVIEW_LABELS[item.status]}
                  </Badge>
                </td>
                <td className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {formatShortDateTime(item.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      ) : null}
      <Pager offset={offset} limit={LIMIT} total={list.data?.total ?? 0} onChange={setOffset} />
      <Dialog
        open={detail !== null}
        onOpenChange={(next) => {
          if (!next) setOpenId(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="break-words leading-snug">
              {detail ? `${detail.playerName} · 第 ${detail.roundNumber} 回合` : ""}
            </DialogTitle>
            <DialogDescription>
              放行表示确认无误，已处置表示已经人工处理过；两者都只是给队列记账，不会改动对局。
            </DialogDescription>
          </DialogHeader>
          {detail ? <ReviewDetail item={detail} onChanged={list.reload} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
