import { useEffect, useState } from "react";
import { Bot, Check, Copy, Lock } from "lucide-react";
import { SettingSwitchRow } from "@/components/common/room/SettingFields";
import { Button } from "@/components/ui/Button";
import { mcpEndpoint, mcpSiteOrigin } from "@/lib/McpConfig";
import { closePageControl, openPageControl } from "@/lib/SiteWs";
import { resetPageControl, usePageControl } from "@/stores/UsePageControl";

/** 交给 Agent 的接管指令：端点 + 这把一次性配对码，别的一概不需要。 */
const pageControlPrompt = (code: string): string =>
  `请读取 ${mcpSiteOrigin()}/llms.txt，并用远程 MCP 连接 ${mcpEndpoint()}。` +
  ` 调用 control_page({ code: "${code}" }) 接管我当前的标签页，之后用 page_state 看页面、page_act 操作控件，只作为 Agent 自行游玩。`;

/** 配对码区块：人类把它（或整段指令）交给 Agent；页面侧不落盘，刷新后要重新生成。 */
function PageCodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState<"code" | "prompt" | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = (kind: "code" | "prompt", text: string) => {
    const writing = navigator.clipboard?.writeText(text);
    if (writing === undefined) return;
    void writing.then(
      () => setCopied(kind),
      () => {}
    );
  };

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">配对码 · 5 分钟内有效</span>
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => copy("code", code)}
          >
            {copied === "code" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied === "code" ? "已复制" : "复制码"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => copy("prompt", pageControlPrompt(code))}
          >
            {copied === "prompt" ? <Check aria-hidden="true" /> : <Bot aria-hidden="true" />}
            {copied === "prompt" ? "已复制" : "复制指令"}
          </Button>
        </div>
      </div>
      <p className="mt-1 font-mono text-base font-semibold tracking-code text-foreground">{code}</p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        把码或整段指令交给 Agent。认领后页面由它操作，你只能旁观，底部的「收回控制」随时可用。
      </p>
    </div>
  );
}

/**
 * 交给 Agent 的唯一入口：首页、大厅、设置与房间内都是这一块，配对方式与提示只有一套。
 * 整块对 Agent 不可见：它不该读到配对码，也不该替人类开关接管。
 */
export function McpPairingPanel({ blockedReason }: { blockedReason?: string }) {
  const { status, code, expiresAt, agentName } = usePageControl();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // 过期的码已经认领不了，留在面板上只会让人类发出一条没用的指令。
  useEffect(() => {
    if (status !== "open" || expiresAt === undefined) return;
    const timer = window.setTimeout(resetPageControl, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [status, expiresAt]);

  const toggle = (next: boolean) => {
    setBusy(true);
    setFailure(null);
    const task = next ? openPageControl() : closePageControl();
    void task
      .catch((error: unknown) => {
        setFailure((error as { message?: string } | null)?.message ?? "操作失败，请重试");
      })
      .finally(() => setBusy(false));
  };

  return (
    <div data-agent-sensitive className="space-y-3">
      <SettingSwitchRow
        label="交给 Agent 操作"
        description={
          blockedReason ?? "生成一次性配对码，Agent 凭它操作这张标签页，看到的不超过你能看到的。"
        }
        checked={status !== "off"}
        onCheckedChange={toggle}
        disabled={busy || (status === "off" && blockedReason !== undefined)}
      />
      {status === "controlled" ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
          <Lock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 text-sm font-medium">{agentName || "Agent"} 正在操作这张标签页</p>
        </div>
      ) : null}
      {code ? <PageCodeBlock code={code} /> : null}
      {failure ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
