import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CloseButton } from "@/components/ui/CloseButton";
import {
  CLIENT_UPDATE_DISMISS_LABEL,
  CLIENT_UPDATE_DOWNLOAD_LABEL,
  clientUpdateNoticeText,
} from "@/lib/AntiCheatCopy";
import { bakaChannel, type BakaClientType } from "@/lib/BakaChannel";
import { useClientPackages, type ClientPackagePlatform } from "@/lib/ClientPackages";
import { dropIn } from "@/lib/Motion";
import { resolveServerUrl } from "@/lib/ServerEndpoint";

/**
 * 客户端更新提醒（仅首页）：壳版本低于服务端公布的最低门槛时，游戏列表上方浮出一条可关的提示。
 *
 * 提醒与门槛是两件事。这里只负责「让玩家早点更新」，拦人仍在服务端 `CEERooms.requireAdmission`：
 * 不进反作弊房就一直能玩，关掉提示、忽略提示都绕不过任何校验。版本比对也交给服务端
 * （`GET /api/client/update-check`），前端不实现第二份比较逻辑，免得两端口径漂移。
 */

/** 存档记的是「已经关掉过哪一档门槛」，服务端抬档后提醒会重新出现。 */
const DISMISS_KEY = "bakagame:client-update-dismissed";

/** 壳类型 → 安装包平台：提醒里那颗按钮按这个挑包。 */
const PLATFORM_BY_CLIENT_TYPE: Record<Exclude<BakaClientType, "web">, ClientPackagePlatform> = {
  desktop: "windows",
  mobile: "android",
};

export interface ClientUpdateFloor {
  clientType: Exclude<BakaClientType, "web">;
  /** 服务端公布的最低版本，非空串。 */
  minimumVersion: string;
}

/** 隐私模式下 localStorage 会抛错：读不到就当没关过，提醒照常出现。 */
const readDismissed = (): string => {
  try {
    return window.localStorage.getItem(DISMISS_KEY) ?? "";
  } catch {
    return "";
  }
};

const writeDismissed = (minimumVersion: string): void => {
  try {
    window.localStorage.setItem(DISMISS_KEY, minimumVersion);
  } catch {
    // 存不下只是这条提示下次还会出现，不影响首页。
  }
};

export function ClientUpdateNotice() {
  const [floor, setFloor] = useState<ClientUpdateFloor | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const channel = bakaChannel();
    if (!channel || channel.clientType === "web" || !channel.clientVersion) return;
    const clientType = channel.clientType;
    const controller = new AbortController();
    const search = new URLSearchParams({ clientType, clientVersion: channel.clientVersion });

    void (async () => {
      try {
        const response = await fetch(
          `${resolveServerUrl("/api/client/update-check")}?${search.toString()}`,
          { signal: controller.signal }
        );
        if (!response.ok) return;
        const body = (await response.json()) as { outdated?: unknown; minimumVersion?: unknown };
        if (body.outdated !== true || typeof body.minimumVersion !== "string") return;
        if (!body.minimumVersion || readDismissed() === body.minimumVersion) return;
        setFloor({ clientType, minimumVersion: body.minimumVersion });
      } catch {
        // 门槛读不到就不提醒：这条是便利，不该拦住首页，也不该反复重试。
      }
    })();

    return () => controller.abort();
  }, []);

  const dismiss = () => {
    if (!floor) return;
    writeDismissed(floor.minimumVersion);
    // 只收起、不清门槛：退场动画期间这条还得用自己的文字收尾。
    setHidden(true);
  };

  // 更新要给的是「自己那一档」的包：安卓壳点开的应当是 APK，不是 Windows 的 exe。
  // 提醒只在有门槛可提醒时才去问一次发布信息。
  const { state } = useClientPackages(Boolean(floor) && !hidden);
  const pkg = floor
    ? state?.packages.find((item) => item.platform === PLATFORM_BY_CLIENT_TYPE[floor.clientType])
    : undefined;

  return (
    <ClientUpdateBanner
      open={!hidden}
      floor={floor}
      downloadUrl={pkg?.available ? pkg.url : undefined}
      onDismiss={dismiss}
    />
  );
}

export interface ClientUpdateBannerProps {
  open: boolean;
  floor: ClientUpdateFloor | null;
  /** 本平台的安装包地址；没发布（或发布信息读不到）时留空，按钮整颗不出现。 */
  downloadUrl?: string;
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
            {clientUpdateNoticeText(floor.clientType, floor.minimumVersion)}
          </span>
          {/* 制品还没推上去时不给链接：不留一枚点了跳到 404 的下载按钮。 */}
          {downloadUrl && (
            <Button asChild size="sm" variant="outline" className="shrink-0">
              <a href={downloadUrl} target="_blank" rel="noreferrer">
                {CLIENT_UPDATE_DOWNLOAD_LABEL}
              </a>
            </Button>
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
