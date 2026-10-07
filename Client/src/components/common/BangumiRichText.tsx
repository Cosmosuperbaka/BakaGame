import { useState, type ReactNode } from "react";
import { parseBangumiMarkup, plainText, type MarkupNode } from "@/lib/BangumiMarkup";
import { cn } from "@/lib/Utils";

/**
 * Bangumi 维基的 BBCode 富文本（角色简介等）。只认 Bangumi 实际用到的那几种标记，
 * 不认识的方括号（「[jack]」这类正文里的写法）原样保留为文字；未闭合或错位的标记同样退回文字，不吞内容。
 * 链接只放行 http(s)，新标签页打开且不带来源；颜色标记只保留文字（固定色在暗色主题下不可读）；
 * 字号只分「放大成小标题」「缩小」两档，不照搬像素值。`[mask]` 是剧透遮罩，点按后揭开，揭开前读屏只报「剧透」。
 */
function safeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  if (shown) return <span className="rounded-sm bg-foreground/8">{children}</span>;
  return (
    <button
      type="button"
      onClick={() => setShown(true)}
      className="rounded-sm bg-foreground px-0.5 text-transparent transition-colors hover:bg-foreground/85 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
    >
      <span className="sr-only">剧透，点按显示</span>
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

function render(nodes: MarkupNode[], masked: boolean, prefix = ""): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}${index}`;
    if (typeof node === "string") return node;
    const children = render(node.children, masked || node.tag === "mask", `${key}.`);
    switch (node.tag) {
      case "b": return <strong key={key} className="font-semibold">{children}</strong>;
      case "i": return <em key={key}>{children}</em>;
      case "u": return <span key={key} className="underline underline-offset-2">{children}</span>;
      case "s": return <s key={key}>{children}</s>;
      case "code": return <code key={key} className="rounded-sm bg-background px-1 font-mono text-[0.9em]">{children}</code>;
      // 遮罩里再套遮罩只算一层，按一次全部揭开
      case "mask": return masked ? <span key={key}>{children}</span> : <Spoiler key={key}>{children}</Spoiler>;
      case "url": {
        // `[url]地址[/url]` 与 `[url=地址]文字[/url]` 两种写法；遮罩里的链接只留文字，免得按钮里套链接。
        const href = safeUrl(node.value ?? plainText(node.children));
        if (!href || masked) return <span key={key}>{children}</span>;
        return (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline-offset-2 hover:underline">
            {children}
          </a>
        );
      }
      case "size": {
        const size = Number(node.value);
        if (size >= 18) return <span key={key} className="text-base font-semibold text-foreground">{children}</span>;
        if (size > 0 && size <= 10) return <span key={key} className="text-xs">{children}</span>;
        return <span key={key}>{children}</span>;
      }
      case "quote": return <span key={key} className="my-1 block border-l-2 border-border pl-3 text-muted-foreground">{children}</span>;
      case "center": return <span key={key} className="block text-center">{children}</span>;
      case "right": return <span key={key} className="block text-right">{children}</span>;
      default: return <span key={key}>{children}</span>;
    }
  });
}

export function BangumiRichText({ text, className }: { text: string; className?: string }) {
  const nodes = parseBangumiMarkup(text.replace(/\r\n?/g, "\n").trim());
  return <div className={cn("whitespace-pre-wrap break-words", className)}>{render(nodes, false)}</div>;
}
