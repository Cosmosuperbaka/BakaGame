import { useState, type MouseEvent } from "react";
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
import type { OriginPoint } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

const OPTIONS: { value: ClientPackagePlatform; label: string }[] = [
  { value: "windows", label: "Windows" },
  { value: "android", label: "Android" },
];

const LABELS: Record<ClientPackagePlatform, string> = { windows: "Windows", android: "Android" };

const originOf = (event: MouseEvent<HTMLElement>): OriginPoint => {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

/** 手机上默认停在安卓那一档：多数人不会再去点一次分段控件。 */
const guessPlatform = (): ClientPackagePlatform =>
  /android/i.test(navigator.userAgent) ? "android" : "windows";

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
  const [platform, setPlatform] = useState<ClientPackagePlatform>(guessPlatform);
  const { state, reload } = useClientPackages(open);
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
          value={platform}
          options={OPTIONS}
          onValueChange={setPlatform}
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
 * 首页右上角的客户端入口：只说「下载客户端」，点了才谈系统与安装包。
 * 网页里也能进反作弊房的是壳，不是这里——入口不该替玩家预设理由。
 * 壳内不渲染：已经在客户端里的人要的是新版，那条路归首页的更新提醒。
 */
export function ClientDownloadEntry() {
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState<OriginPoint | null>(null);
  if (isBakaClient()) return null;

  return (
    <>
      <Button
        variant="ghost"
        aria-label="下载客户端"
        onClick={(event) => {
          setOrigin(originOf(event));
          setOpen(true);
        }}
      >
        <Download />
        {/* 矮屏（横屏手机）上页头本来就挤，这一排又贴着标题的位置：只留图标，名称走 aria-label。 */}
        <span className="[@media(max-height:680px)]:hidden">下载客户端</span>
      </Button>
      <ClientDownloadDialog open={open} onOpenChange={setOpen} origin={origin} />
    </>
  );
}
