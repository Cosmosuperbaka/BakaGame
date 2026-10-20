import { useEffect, useState } from "react";
import type { PlayerAccount, PublicProfile } from "@bakagame/shared";
import { loadPublicProfile } from "@/lib/ProfileCache";
import { Spinner } from "@/components/ui/Spinner";
import { Hint } from "@/components/ui/Tooltip";
import { apiErrorMessage, avatarSrc } from "@/lib/Api";

type CardState =
  | { status: "loading" }
  | { status: "ready"; profile: PublicProfile }
  | { status: "error"; message: string };
type Loaded = { key: string; state: CardState };

/**
 * 登录玩家的资料卡：头像、账号昵称，本人公开时再显示 QQ 号。
 * 游戏昵称与账号昵称互不捆绑，两者不同时同时写出，避免误认。
 */
export function ProfileCard({
  account,
  playerName,
}: {
  account: PlayerAccount;
  playerName: string;
}) {
  // 结果记在「用户 + 第几次尝试」名下：换人或点重试时旧结果自然作废，读作加载中。
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = `${account.userId}:${attempt}`;
  const state: CardState = loaded?.key === key ? loaded.state : { status: "loading" };

  useEffect(() => {
    let alive = true;
    loadPublicProfile(account.userId).then(
      (profile) => alive && setLoaded({ key, state: { status: "ready", profile } }),
      (error: unknown) =>
        alive &&
        setLoaded({
          key,
          state: { status: "error", message: apiErrorMessage(error, "资料加载失败") },
        })
    );
    return () => {
      alive = false;
    };
  }, [account.userId, key]);

  const image = account.image ?? (state.status === "ready" ? state.profile.image : null);

  return (
    <div
      className="flex w-64 max-w-[calc(100vw-2rem)] items-center gap-3 px-4 py-3"
      aria-live="polite"
    >
      {image ? (
        <img
          src={avatarSrc(image)}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="h-14 w-14 shrink-0 rounded-md border border-border object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-muted text-lg text-muted-foreground"
        >
          {Array.from(playerName)[0] ?? "?"}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {state.status === "loading" ? (
          <span role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            正在读取资料
          </span>
        ) : state.status === "error" ? (
          <span className="flex items-center gap-2 text-xs">
            <span role="alert" className="text-destructive">
              {state.message}
            </span>
            <button
              type="button"
              className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => setAttempt((value) => value + 1)}
            >
              重试
            </button>
          </span>
        ) : (
          <>
            <Hint label={state.profile.name}>
              <div className="truncate font-semibold">{state.profile.name}</div>
            </Hint>
            {state.profile.name !== playerName ? (
              <Hint label={playerName}>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  游戏昵称 {playerName}
                </div>
              </Hint>
            ) : null}
            <div className="mt-1 text-xs text-muted-foreground">
              {state.profile.qqNumber ? (
                <>
                  QQ <span className="font-mono">{state.profile.qqNumber}</span>
                </>
              ) : (
                "QQ 号未公开"
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
