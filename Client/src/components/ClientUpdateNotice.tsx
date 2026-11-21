import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CloseButton } from "@/components/ui/CloseButton";
import {
  CLIENT_UPDATE_DISMISS_LABEL,
  CLIENT_UPDATE_DOWNLOAD_LABEL,
  CLIENT_UPDATE_RESTART_LABEL,
  clientUpdateNoticeText,
} from "@/lib/AntiCheatCopy";
import { bakaChannel, type BakaClientType } from "@/lib/BakaChannel";
import {
  packagePlatformOf,
  useClientPackages,
  type ClientPackagePlatform,
} from "@/lib/ClientPackages";
import { installDesktopUpdate, useDesktopUpdateStatus } from "@/lib/DesktopUpdate";
import { dropIn } from "@/lib/motion/NamedMoves";
import { resolveServerUrl } from "@/lib/ServerEndpoint";

/**
 * 客户端更新提醒（仅首页）：壳版本低于服务端公布的最低门槛、或低于已发布的最新壳版本时，
 * 游戏列表上方浮出一条可关的提示。
 *
 * 提醒与门槛是两件事。这里只负责「让玩家早点更新」，拦人仍在服务端 `CEERooms.requireAdmission`：
 * 不进反作弊房就一直能玩，关掉提示、忽略提示都绕不过任何校验。版本比对也交给服务端
 * （`GET /api/client/update-check`），前端不实现第二份比较逻辑，免得两端口径漂移。
 *
 * 两档提醒的来源不同：`required` 是最低准入版本（与服务端硬门槛同源），`available` 是发布
 * 流水线写下的最新壳版本。后者只说明「有新版可拿」，不代表协议变更，不能自动抬硬门槛。
 *
 * 桌面壳会在后台自己下载并校验新版：壳报「已就绪」时按钮换成「重启更新」，交给壳安装并重启；
 * 没就绪、壳不支持或安装失败时照旧给「下载最新版」链接兜底。
 */

/** 存档记的是「已经关掉过哪一档提醒」，服务端换档或抬版本后提醒会重新出现。 */
const DISMISS_KEY = "bakagame:client-update-dismissed";

export interface ClientUpdateFloor {
  clientType: Exclude<BakaClientType, "web">;
  /** `required` = 低于服务端最低准入版本；`available` = 低于已发布的最新壳版本。 */
  mode: "required" | "available";
  /** 要提示到的版本，非空串。 */
  version: string;
}

/** 存档要区分「关了哪一档提醒」：同一版本从软提醒抬成硬门槛时必须重新说一次。 */
const dismissKeyOf = (floor: ClientUpdateFloor): string => `${floor.mode}:${floor.version}`;

/** 隐私模式下 localStorage 会抛错：读不到就当没关过，提醒照常出现。 */
const readDismissed = (): string => {
  try {
    return window.localStorage.getItem(DISMISS_KEY) ?? "";
  } catch {
    return "";
  }
};

const writeDismissed = (key: string): void => {
  try {
    window.localStorage.setItem(DISMISS_KEY, key);
  } catch {
    // 存不下只是这条提示下次还会出现，不影响首页。
  }
};

/** 要提醒的那一档，连同提醒里那颗按钮该给哪个平台的包（按壳自报的类型与平台定）。 */
interface PendingNotice {
  floor: ClientUpdateFloor;
  packagePlatform: ClientPackagePlatform;
}

export function ClientUpdateNotice() {
  const [notice, setNotice] = useState<PendingNotice | null>(null);
  const [hidden, setHidden] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  const floor = notice?.floor ?? null;

  useEffect(() => {
    const channel = bakaChannel();
    if (!channel || channel.clientType === "web" || !channel.clientVersion) return;
    const clientType = channel.clientType;
    const packagePlatform = packagePlatformOf(clientType, channel.platform);
    const controller = new AbortController();
    const search = new URLSearchParams({ clientType, clientVersion: channel.clientVersion });
    // 壳自报的平台随查询带上：服务端按它挑「最新已发布版」该看哪个平台的包，Mac 壳不拿 Windows 的版本比
    if (channel.platform) search.set("platform", channel.platform);

    void (async () => {
      try {
        const response = await fetch(
          `${resolveServerUrl("/api/client/update-check")}?${search.toString()}`,
          { signal: controller.signal }
        );
        if (!response.ok) return;
        const body = (await response.json()) as {
          outdated?: unknown;
          minimumVersion?: unknown;
          latestVersion?: unknown;
          behindLatest?: unknown;
        };
        // 硬门槛优先：低于最低准入版本时，文案必须说清「进不了反作弊房」，
        // 不能降级成只说「有新版本可用」。服务端已按同一次读取给出两档。
        const next: ClientUpdateFloor | null =
          body.outdated === true && typeof body.minimumVersion === "string" && body.minimumVersion
            ? { clientType, mode: "required", version: body.minimumVersion }
            : body.behindLatest === true &&
                typeof body.latestVersion === "string" &&
                body.latestVersion
              ? { clientType, mode: "available", version: body.latestVersion }
              : null;
        if (!next || readDismissed() === dismissKeyOf(next)) return;
        setNotice({ floor: next, packagePlatform });
      } catch {
        // 门槛读不到就不提醒：这条是便利，不该拦住首页，也不该反复重试。
      }
    })();

    return () => controller.abort();
  }, []);

  const dismiss = () => {
    if (!floor) return;
    writeDismissed(dismissKeyOf(floor));
    // 只收起、不清门槛：退场动画期间这条还得用自己的文字收尾。
    setHidden(true);
  };

  // 更新要给的是「自己那一档」的包：安卓壳点开的应当是 APK，Mac 壳点开的应当是 Mac 的包，
  // 都不是 Windows 的 exe；本平台没发布时按钮整颗不出现。提醒只在有门槛可提醒时才去问一次发布信息。
  const { state } = useClientPackages(Boolean(floor) && !hidden);
  const pkg = notice
    ? state?.packages.find((item) => item.platform === notice.packagePlatform)
    : undefined;
  // 只有桌面壳会自己下载更新；提醒在场时才去问它
  const desktop = useDesktopUpdateStatus(floor?.clientType === "desktop" && !hidden);
  const restartReady = desktop?.state === "ready" && !restartFailed;

  const restart = () => {
    setRestarting(true);
    // 成功时壳会退出，等不到返回；失败就回落到下载链接，不再给一颗点了没反应的按钮
    void installDesktopUpdate().then((ok) => {
      if (ok) return;
      setRestarting(false);
      setRestartFailed(true);
    });
  };

  return (
    <ClientUpdateBanner
      open={!hidden}
      floor={floor}
      downloadUrl={pkg?.available ? pkg.url : undefined}
      onRestart={restartReady ? restart : undefined}
      restarting={restarting}
      onDismiss={dismiss}
    />
  );
}

export interface ClientUpdateBannerProps {
  open: boolean;
  floor: ClientUpdateFloor | null;
  /** 本平台的安装包地址；没发布（或发布信息读不到）时留空，按钮整颗不出现。 */
  downloadUrl?: string;
  /** 壳已下载并校验好新版时给出：按钮换成「重启更新」，下载链接让位。 */
  onRestart?: () => void;
  /** 已点「重启更新」、等壳安装时为真：按钮进入进行中，防止连点。 */
  restarting?: boolean;
  onDismiss: () => void;
}

/**
 * 提醒的展示部分，只由 props 驱动；检测与存档留在 `ClientUpdateNotice`，Storybook 渲染这一层。
 *
 * 落位在首页内容区顶部而不是底部浮层：底部那条浮层是网页新版本提醒（`VersionUpdateNotice`）
 * 的位置，两条「该更新了」叠在同一处会互相盖掉。
 */
export function ClientUpdateBanner({
  open,
  floor,
  downloadUrl,
  onRestart,
  restarting = false,
  onDismiss,
}: ClientUpdateBannerProps) {
  return (
    <AnimatePresence>
      {open && floor && (
        <motion.div
          key="client-update"
          role="status"
          variants={dropIn}
          initial="initial"
          animate="animate"
          exit="exit"
          className="flex items-center gap-2 rounded-md border border-border bg-card/95 px-3 py-2 text-card-foreground shadow-sm"
        >
          <Download className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-xs leading-snug">
            {clientUpdateNoticeText(floor.clientType, floor.version, floor.mode)}
          </span>
          {/* 壳已备好新版时只给「重启更新」；否则给下载链接，制品还没推上去时连链接也不给，
              不留一枚点了跳到 404 的下载按钮。 */}
          {onRestart ? (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              loading={restarting}
              onClick={onRestart}
            >
              {CLIENT_UPDATE_RESTART_LABEL}
            </Button>
          ) : (
            downloadUrl && (
              <Button asChild size="sm" variant="outline" className="shrink-0">
                <a href={downloadUrl} target="_blank" rel="noreferrer">
                  {CLIENT_UPDATE_DOWNLOAD_LABEL}
                </a>
              </Button>
            )
          )}
          <CloseButton
            aria-label={CLIENT_UPDATE_DISMISS_LABEL}
            className="h-7 w-7"
            onClick={onDismiss}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
