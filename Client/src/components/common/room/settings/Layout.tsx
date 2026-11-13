/* eslint-disable react-refresh/only-export-components -- 只读上下文的钩子与字段容器同属一套设置表单布局。 */
import { createContext, useContext, type ReactNode } from "react";
import { CollapsibleRegion } from "@/components/ui/Collapsible";
import { Label } from "@/components/ui/Label";
import { PresenceBoundary } from "@/components/ui/PresenceBoundary";
import { collapsible } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { AnimatePresence, motion } from "framer-motion";
import { type LucideIcon } from "lucide-react";

// 等待页设置面板共用的字段：标签与控件显式关联，说明经 aria-describedby 挂到控件上，读屏能读出每个开关与输入的名称和说明。
// 禁用时标签随控件一起变淡；说明保持原色，它往往就是禁用的原因（如「8 人开启」）。
// 非房主看到同一份结构：外层包 `SettingsReadOnly`，每个字段把控件换成右侧的取值文字，标签与说明原样保留。
// 字段分在同目录四个文件：Layout 是行、分区与只读上下文，NumberFields、ChoiceFields、TextFields 各管一类控件。

const ReadOnlyContext = createContext(false);

/** 包住一组设置，里面的字段都只显示取值、不渲染控件。 */
export function SettingsReadOnly({
  readOnly,
  children,
}: {
  readOnly: boolean;
  children: ReactNode;
}) {
  return <ReadOnlyContext.Provider value={readOnly}>{children}</ReadOnlyContext.Provider>;
}

/** 当前字段是否只读；游戏自有的控件（歌单读取、目录同步）也据此收起操作。 */
export function useSettingsReadOnly() {
  return useContext(ReadOnlyContext);
}

/** 只读时右侧的取值：常规字重、前景色，数字等宽，读起来像一张清单。 */
export function ReadOnlyValue({
  children,
  muted = false,
}: {
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        // max-w-full：取值很长（多选列表、歌单名）时在行内折行，不顶出面板。
        "max-w-full shrink-0 text-right text-sm tabular-nums",
        muted ? "text-muted-foreground" : "text-foreground"
      )}
    >
      {children}
    </span>
  );
}

/**
 * 一行设置：左侧标签（可带图标与单位）与说明，右侧控件。手机上两边放不下时控件整组折到下方靠右，
 * 标签列不被挤成逐字断行。标签统一 `text-sm`，说明 `text-xs` 弱化色。
 */
export function SettingRow({
  label,
  unit,
  description,
  icon: Icon,
  htmlFor,
  labelId,
  descriptionId,
  disabled = false,
  children,
}: {
  label: string;
  unit?: string;
  description?: string;
  icon?: LucideIcon;
  /** 控件的 id；只读时没有控件，标签退回普通文字 */
  htmlFor?: string;
  /** 控件组（分段、滑动条）经 aria-labelledby 指向的标签 id */
  labelId?: string;
  descriptionId?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const text = (
    <>
      {label}
      {unit ? <span className="font-normal text-muted-foreground">（{unit}）</span> : null}
    </>
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-40">
        <div className={cn("flex items-center gap-2", disabled && "opacity-50")}>
          {Icon ? (
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : null}
          {htmlFor ? (
            <Label htmlFor={htmlFor} className="font-serif leading-snug font-normal">
              {text}
            </Label>
          ) : (
            <span id={labelId} className="font-serif text-sm leading-snug">
              {text}
            </span>
          )}
        </div>
        {description ? (
          <p id={descriptionId} className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center">{children}</div>
    </div>
  );
}

/** 上下堆叠的字段（文本、下拉、分段）：标签在上，控件占满整行；只读时退回标签与取值同一行。 */
export function StackedField({
  label,
  description,
  htmlFor,
  labelId,
  descriptionId,
  disabled = false,
  children,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  labelId?: string;
  descriptionId?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      {htmlFor ? (
        <Label
          id={labelId}
          htmlFor={htmlFor}
          className={cn("font-serif leading-snug font-normal", disabled && "opacity-50")}
        >
          {label}
        </Label>
      ) : (
        <span
          id={labelId}
          className={cn("font-serif text-sm leading-snug", disabled && "opacity-50")}
        >
          {label}
        </span>
      )}
      {children}
      {description ? (
        <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 一列字段的间距：后一项的上外边距（owl 选择器），不用 `space-y`。
 * 这样 `SettingReveal` 收起后整个移除时不残留间距，展开时间距算在它自己的内边距里、随高度一起补间，不会先跳 16px。
 */
export function SettingsFields({ children }: { children: ReactNode }) {
  return <div className="[&>*+*]:mt-4">{children}</div>;
}

/** 随开关出现的从属字段（歌词行数、房间密码）：高度按 `collapsible` 补间，上方间距在内边距里，不跳。只放在 `SettingsFields` 里。 */
export function SettingReveal({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <CollapsibleRegion open={open} className="!mt-0">
      <div className="pt-4">{children}</div>
    </CollapsibleRegion>
  );
}

/** 只读的一项：标签与取值。游戏自有的复合控件（歌单、追加作品）只读时用它。 */
export function SettingValue({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description?: string;
}) {
  return (
    <SettingRow label={label} description={description}>
      <ReadOnlyValue muted={!value}>{value || "未设置"}</ReadOnlyValue>
    </SettingRow>
  );
}

/**
 * 折叠组内的小节：可选的小标题（带图标）与一组字段。相邻小节之间一道分隔线，组内平铺的长列表由此分出层次。
 * `open` 为假时整节按 `collapsible` 收起（自动出题的筛选随出题方式出现）；分隔线与上间距算在节内，随高度一起补间。
 * 小节须是同一容器里的兄弟元素，第一节不画分隔线：不要再给某一节外面套一层包装，否则它会被当成「第一节」，
 * 分隔线与上间距一起消失。Agent 不该替人类改的一节传 `agentSensitive`，标记直接落在节上。
 */
export function SettingsSection({
  title,
  icon: Icon,
  open = true,
  agentSensitive = false,
  children,
}: {
  title?: string;
  icon?: LucideIcon;
  open?: boolean;
  /** 整节对 Agent 不可操作（账号相关的设置），等同于在节上挂 `data-agent-sensitive`。 */
  agentSensitive?: boolean;
  children: ReactNode;
}) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        // flow-root 让节始终是 BFC：内层的上外边距留在节内、计入补间的高度；裁切只在补间期间由变体打开，字段的晕光不被切掉。
        <motion.section
          variants={collapsible}
          initial="initial"
          animate="animate"
          exit="exit"
          className="flow-root"
          data-agent-sensitive={agentSensitive || undefined}
        >
          <div className="[section:not(:first-child)>&]:mt-4 [section:not(:first-child)>&]:border-t [section:not(:first-child)>&]:pt-4">
            <SettingsFields>
              {title ? (
                <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                  {title}
                </h4>
              ) : null}
              {/* 默认展开的设置组里之后才出现的字段照常入场 */}
              <PresenceBoundary>{children}</PresenceBoundary>
            </SettingsFields>
          </div>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}
