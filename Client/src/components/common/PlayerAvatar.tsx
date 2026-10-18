import { useState } from "react";
import { avatarSrc } from "@/lib/Api";
import { cn } from "@/lib/Utils";

/**
 * 玩家行左端的头像格。尺寸必须与历史实现保持一致（`h-8 w-8`）：
 * 玩家列与发言历史的逐行对齐依赖同一行高与同一首列宽，换渲染方式不得改尺寸。
 * 登录玩家显示账号头像，游客或头像加载失败时退回昵称首字；只作昵称旁的身份提示，不编码得分或在线状态。
 */
export function PlayerAvatar({
  name,
  me = false,
  image,
  className,
}: {
  name: string;
  me?: boolean;
  image?: string | null;
  className?: string;
}) {
  const initial = Array.from(name)[0] ?? "?";
  // 记下加载失败的地址而不是布尔值：头像换版本（URL 变化）后自动重试。
  const [failed, setFailed] = useState<string | null>(null);
  const base = "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm leading-none";
  if (image && failed !== image) {
    return (
      <img
        src={avatarSrc(image)}
        alt=""
        aria-hidden="true"
        draggable={false}
        loading="lazy"
        onError={() => setFailed(image)}
        className={cn(base, "border border-border object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        base,
        me ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
        className
      )}
    >
      {initial}
    </span>
  );
}
