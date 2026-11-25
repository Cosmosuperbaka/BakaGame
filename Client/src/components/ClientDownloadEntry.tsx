import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { isBakaClient } from "@/lib/BakaChannel";
import {
  formatPackageBuild,
  formatPackageSize,
  useClientPackages,
  type ClientPackage,
  type ClientPackagePlatform,
} from "@/lib/ClientPackages";
import { useMinWidth } from "@/hooks/UseMinWidth";
import { useOriginTracker } from "@/hooks/UseOriginTracker";
import type { OriginPoint } from "@/lib/motion/Origin";
import { cn } from "@/lib/Utils";

/**
 * 只在 macOS 档、包确实可下载时给出的两条安装提示：
 * - 直接在 dmg 或下载目录里运行时，系统把 App 搬到只读的随机路径上跑，自动更新替换不了它，
 *   所以先说拖进「应用程序」。
 * - 包没有经过苹果公证，首次打开会被系统拦下，再说怎么放行。
 */
const MACOS_FIRST_OPEN_HINT =
  "打开 dmg 后先把 BakaGame 拖进「应用程序」再启动，否则收不到自动更新。首次打开若被系统拦下，到系统设置的「隐私与安全性」里点「仍要打开」。";

const LABELS: Record<ClientPackagePlatform, string> = {
  windows: "Windows",
  macos: "macOS",
  android: "Android",
};

/** 分段控件里的顺序：两个桌面平台在前。 */
const ORDER: ClientPackagePlatform[] = ["windows", "macos", "android"];

/**
 * Windows 与安卓两档始终列出（包没发布时写「尚未发布」）；macOS 只在服务端清单里有它时才出现：
 * Mac 包正式分发前地址配成空串，弹窗与加入 macOS 之前一模一样，不给 Mac 用户一档点不动的选项。
 */
const ALWAYS_LISTED: ClientPackagePlatform[] = ["windows", "android"];

const visiblePlatforms = (packages: ClientPackage[] | undefined): ClientPackagePlatform[] =>
  ORDER.filter(
    (platform) =>
      ALWAYS_LISTED.includes(platform) || packages?.some((item) => item.platform === platform)
  );

/**
 * 按设备猜默认档：手机停在安卓，Mac 停在 macOS（该档没列出时回到 Windows），其余 Windows。
 * iPad 的桌面版浏览器也自称 Macintosh，靠多点触控把它排除：Mac 安装包装不到 iPad 上。
 */
const guessPlatform = (): ClientPackagePlatform => {
  const agent = navigator.userAgent;
  if (/android/i.test(agent)) return "android";
  if (/Macintosh/i.test(agent) && !(navigator.maxTouchPoints > 1)) return "macos";
  return "windows";
};

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn("truncate text-sm", !value && "text-muted-foreground/60")}>
        {value || "未知"}
      </span>
    </div>
  );
}

function SkeletonRow() {
  return <div className="my-2 h-4 rounded-sm bg-foreground/8" aria-hidden="true" />;
}

function PackageDetails({ pkg }: { pkg: ClientPackage | undefined }) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-1.5">
      <DetailRow label="客户端版本" value={pkg?.version ?? ""} />
      <DetailRow label="安装包架构" value={pkg?.arch ?? ""} />
      <DetailRow label="构建日期" value={formatPackageBuild(pkg?.builtAt)} />
      <DetailRow label="文件大小" value={formatPackageSize(pkg?.sizeBytes)} />
    </div>
  );
}

export interface ClientDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  origin?: OriginPoint | null;
}

/** 平台选择弹窗：先选系统，再照安装包自己的元数据决定给不给下载。 */
export function ClientDownloadDialog({ open, onOpenChange, origin }: ClientDownloadDialogProps) {
  const [guessed] = useState<ClientPackagePlatform>(guessPlatform);
  const [chosen, setChosen] = useState<ClientPackagePlatform | null>(null);
  const { state, reload } = useClientPackages(open);
  const platforms = visiblePlatforms(state?.packages);
  // 玩家点过的档优先；没点过就按设备猜，猜中的档不在列表里时落回 Windows
  const preferred = chosen ?? guessed;
  const platform = platforms.includes(preferred) ? preferred : "windows";
  const options = platforms.map((value) => ({ value, label: LABELS[value] }));
  // 手机宽度下三档平分不到一行舒展的宽度，换紧凑档；只有两档时保持原样
  const roomy = useMinWidth("sm");
  const compactSwitch = platforms.length > 2 && !roomy;
  const pkg = state?.packages.find((item) => item.platform === platform);
  const downloadLabel = `下载 ${LABELS[platform]} 安装包`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} origin={origin}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>下载客户端</DialogTitle>
          <DialogDescription>选你的设备系统，构建日期与文件大小取自安装包本身。</DialogDescription>
        </DialogHeader>

        <SegmentedControl
          aria-label="选择下载平台"
          size={compactSwitch ? "sm" : "default"}
          value={platform}
          options={options}
          onValueChange={setChosen}
          className="w-full"
        />

        {!state && (
          <div className="rounded-md bg-muted/40 px-3 py-1.5">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        )}
        {state?.failed && (
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2">
            <span className="text-xs text-muted-foreground">暂时读不到发布信息。</span>
            <Button size="sm" variant="ghost" onClick={reload}>
              重试
            </Button>
          </div>
        )}
        {state && !state.failed && <PackageDetails pkg={pkg} />}
        {platform === "macos" && pkg?.available && (
          <p className="text-xs leading-relaxed text-muted-foreground">{MACOS_FIRST_OPEN_HINT}</p>
        )}

        {/* 没发布就不给链接：一枚点了跳到 404 的按钮比不按钮更糟。 */}
        {pkg?.available ? (
          <Button asChild>
            <a href={pkg.url} target="_blank" rel="noreferrer">
              <Download />
              {downloadLabel}
            </a>
          </Button>
        ) : (
          <Button disabled>
            <Download />
            {state?.failed ? "暂时无法下载" : "尚未发布"}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 首页的客户端入口：只说「下载客户端」，点了才谈系统与安装包。
 * 网页里也能进反作弊房的是壳，不是这里——入口不该替玩家预设理由。
 * 壳内不渲染：已经在客户端里的人要的是新版，那条路归首页的更新提醒。
 * `compact` 用于页脚服务状态旁：与相邻的文本入口同一档尺寸与弱化色。
 */
export function ClientDownloadEntry({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const { origin, capture } = useOriginTracker();
  if (isBakaClient()) return null;

  return (
    <>
      <Button
        variant="ghost"
        size={compact ? "sm" : "default"}
        aria-label="下载客户端"
        className={compact ? "gap-1.5 px-2 text-xs text-muted-foreground" : undefined}
        onClick={(event) => {
          capture(event);
          setOpen(true);
        }}
      >
        <Download />
        <span className={compact ? undefined : "[@media(max-height:680px)]:hidden"}>
          下载客户端
        </span>
      </Button>
      <ClientDownloadDialog open={open} onOpenChange={setOpen} origin={origin} />
    </>
  );
}
