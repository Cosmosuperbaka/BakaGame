import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Search } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { useMeasuredHeight } from "@/hooks/UseMeasuredHeight";
import { listContainer, listItem, optionTappable, popover, spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

/** 面板里的说明行：`busy` 查询中、`info` 空结果之类的说明、`error` 失败（读屏立即播报）。 */
export interface SearchStatus {
  tone: "busy" | "info" | "error";
  text: string;
}

/** 二级列表（作品下的角色、番剧下的关联曲）顶上的返回行，键盘也能选到。 */
export interface SearchBack {
  label: string;
  /** 行尾的补充说明，如当前所在的作品名 */
  detail?: string;
  onBack: () => void;
}

export interface SearchComboboxProps<T> {
  value: string;
  onValueChange: (value: string) => void;
  /** 输入框的可访问名，结果列表沿用它 */
  label: string;
  placeholder: string;
  maxLength?: number;
  disabled?: boolean;
  /** 输入框右侧的搜索按钮。按下不抢走输入框的焦点，结果面板保持展开 */
  actions?: ReactNode;
  /** 没有高亮候选时按回车：立即搜索 */
  onSubmit?: () => void;
  /** 有旧结果时的后台查询：只在输入框尾部转圈，不清空面板 */
  busy?: boolean;
  options: readonly T[];
  getKey: (option: T) => string;
  renderOption: (option: T) => ReactNode;
  isOptionDisabled?: (option: T) => boolean;
  onSelect: (option: T) => void;
  /** 正在提交的候选：该行转圈，其余候选暂不可选 */
  pendingKey?: string | null;
  /** 候选整批更换（新的查询、进出二级列表）时变化，列表按序重新推入 */
  listKey: string;
  status?: SearchStatus | null;
  back?: SearchBack | null;
  className?: string;
}

type SearchItem<T> = { kind: "back"; key: string; back: SearchBack } | { kind: "option"; key: string; option: T };

/**
 * 浮动搜索框：结果面板浮在下方内容之上，不把页面往下挤。
 * 面板随焦点进出：输入框（或右侧按钮）获得焦点且有内容可显示时展开，焦点离开、按 Esc 或点外面就收起，不设关闭按钮；
 * 再次聚焦时旧结果原样回来。点整行即选中，上下键移动高亮、回车选中，没有高亮时回车走 `onSubmit`。
 * 选中后面板不自己收起：调用处提交成功后清空结果，面板随之退场；提交失败时结果还在，可以换一个再选。
 * 面板走 Portal，所在区域滚动或裁切（游戏区、弹窗）都不会截断它；宽度跟输入框一致，窄屏上输入框被按钮挤窄时至少取 20rem
 * （不超出视口），由碰撞避让推回屏内；下方空间不够时翻到上方。
 */
export function SearchCombobox<T>({
  value,
  onValueChange,
  label,
  placeholder,
  maxLength,
  disabled = false,
  actions,
  onSubmit,
  busy = false,
  options,
  getKey,
  renderOption,
  isOptionDisabled,
  onSelect,
  pendingKey = null,
  listKey,
  status = null,
  back = null,
  className,
}: SearchComboboxProps<T>) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [engaged, setEngaged] = useState(false);
  const [active, setActive] = useState({ listKey, index: -1 });

  const items: SearchItem<T>[] = [
    ...(back ? [{ kind: "back" as const, key: "__back", back }] : []),
    ...options.map((option) => ({ kind: "option" as const, key: getKey(option), option })),
  ];
  const open = engaged && !disabled && (items.length > 0 || status !== null);
  // 高亮跟着这一批候选走：换了一批或列表变短，高亮回到「无」，不会落在别的候选上。
  const activeIndex = active.listKey === listKey && active.index < items.length ? active.index : -1;
  const optionId = (index: number) => `${listId}-option-${index}`;

  const unavailable = (item: SearchItem<T>) =>
    item.kind === "option" && (pendingKey !== null || Boolean(isOptionDisabled?.(item.option)));

  const choose = (item: SearchItem<T>) => {
    if (item.kind === "back") item.back.onBack();
    else if (!unavailable(item)) onSelect(item.option);
  };

  const highlight = (index: number, reveal: boolean) => {
    setActive({ listKey, index });
    if (reveal) document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 输入法组字时的方向键与回车属于输入法，不能拿来选候选或提交。
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (items.length === 0) return;
      event.preventDefault();
      setEngaged(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const start = step > 0 ? 0 : items.length - 1;
      highlight(activeIndex < 0 ? start : (activeIndex + step + items.length) % items.length, true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = open && activeIndex >= 0 ? items[activeIndex] : undefined;
      if (item) choose(item);
      else {
        setEngaged(true);
        onSubmit?.();
      }
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={(next) => { if (!next) setEngaged(false); }}>
      <div
        ref={rootRef}
        className={cn("flex min-w-0 gap-2", className)}
        onFocus={() => setEngaged(true)}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && rootRef.current?.contains(next)) return;
          setEngaged(false);
        }}
      >
        <Popover.Anchor asChild>
          <div
            data-disabled={disabled || undefined}
            className={cn(
              "field-frame flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md bg-background px-3",
              disabled && "opacity-50",
            )}
          >
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label={label}
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open && items.length > 0 ? listId : undefined}
              aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
              value={value}
              maxLength={maxLength}
              placeholder={placeholder}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              onChange={(event) => {
                setEngaged(true);
                onValueChange(event.target.value);
              }}
              onKeyDown={onKeyDown}
              // 按 Esc 收起后输入框仍有焦点，再点一下要能把面板叫回来。
              onClick={() => setEngaged(true)}
              className="h-full min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed"
            />
            {busy ? <Spinner className="text-muted-foreground" /> : null}
          </div>
        </Popover.Anchor>
        {actions ? (
          // 按下搜索按钮不让按钮抢焦点，焦点留在（或回到）输入框：光标不丢，面板也不会因为失焦先收起再展开。
          <div
            className="flex shrink-0 gap-2"
            onMouseDown={(event) => {
              event.preventDefault();
              inputRef.current?.focus();
            }}
          >
            {actions}
          </div>
        ) : null}
      </div>
      <AnimatePresence>
        {open ? (
          <Popover.Portal forceMount>
            <Popover.Content
              forceMount
              asChild
              role={undefined}
              side="bottom"
              align="start"
              sideOffset={6}
              collisionPadding={12}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
              onInteractOutside={(event) => {
                // 点回输入框、点右侧的搜索按钮都算在搜索框里面，不收起。
                if (event.target instanceof Node && rootRef.current?.contains(event.target)) event.preventDefault();
              }}
              // 面板里没有可聚焦的东西，按下也不能把焦点从输入框带走，否则失焦会先把面板关掉。
              onMouseDown={(event) => event.preventDefault()}
            >
              <motion.div
                variants={popover}
                initial="initial"
                animate="animate"
                exit="exit"
                className="z-popover w-(--radix-popover-trigger-width) min-w-[min(20rem,calc(100vw-1.5rem))] origin-(--radix-popover-content-transform-origin) overflow-hidden floating-surface shadow-md"
              >
                <SearchPanel
                  items={items}
                  listId={listId}
                  listKey={listKey}
                  label={label}
                  status={status}
                  activeIndex={activeIndex}
                  pendingKey={pendingKey}
                  optionId={optionId}
                  unavailable={unavailable}
                  renderOption={renderOption}
                  onHighlight={(index) => { if (index !== activeIndex) highlight(index, false); }}
                  onChoose={choose}
                />
              </motion.div>
            </Popover.Content>
          </Popover.Portal>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}

interface SearchPanelProps<T> {
  items: SearchItem<T>[];
  listId: string;
  listKey: string;
  label: string;
  status: SearchStatus | null;
  activeIndex: number;
  pendingKey: string | null;
  optionId: (index: number) => string;
  unavailable: (item: SearchItem<T>) => boolean;
  renderOption: (option: T) => ReactNode;
  onHighlight: (index: number) => void;
  onChoose: (item: SearchItem<T>) => void;
}

/**
 * 面板内容。高度随候选多少用弹性补间（`spring.settle`），换一批结果、进出二级列表时面板平滑伸缩，不跳。
 * 旧的一批候选经 popLayout 抽出文档流、按序淡出，新的一批同时推入，两批交叉而不是先清空再出现。
 */
function SearchPanel<T>({
  items,
  listId,
  listKey,
  label,
  status,
  activeIndex,
  pendingKey,
  optionId,
  unavailable,
  renderOption,
  onHighlight,
  onChoose,
}: SearchPanelProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const height = useMeasuredHeight(scrollRef);

  return (
    <motion.div initial={false} animate={height === null ? undefined : { height }} transition={spring.settle} className="overflow-hidden">
      <div
        ref={scrollRef}
        className="scrollbar-hidden relative max-h-[min(22rem,var(--radix-popover-content-available-height))] overflow-y-auto overscroll-contain"
      >
        {status ? (
          <motion.p
            key={`${status.tone}:${status.text}`}
            variants={listItem}
            initial="initial"
            animate="animate"
            style={{ originX: 0 }}
            role={status.tone === "error" ? "alert" : "status"}
            className={cn(
              "flex items-center gap-2 px-3 py-3 text-sm",
              status.tone === "error" ? "text-destructive" : "text-muted-foreground",
              items.length > 0 && "border-b",
            )}
          >
            {status.tone === "busy" ? <Spinner /> : null}
            {status.text}
          </motion.p>
        ) : null}
        <AnimatePresence initial={false} mode="popLayout">
          {items.length > 0 ? (
            <motion.ul
              key={listKey}
              id={listId}
              role="listbox"
              aria-label={`${label}结果`}
              variants={listContainer(items.length)}
              initial="initial"
              animate="animate"
              exit="exit"
              className="w-full"
            >
              {items.map((item, index) => {
                const blocked = unavailable(item);
                const highlighted = index === activeIndex;
                return (
                  <motion.li
                    key={item.key}
                    id={optionId(index)}
                    role="option"
                    aria-selected={highlighted}
                    aria-disabled={blocked || undefined}
                    data-active={highlighted || undefined}
                    variants={listItem}
                    style={{ originX: 0 }}
                    {...(blocked ? undefined : optionTappable)}
                    onMouseMove={() => onHighlight(index)}
                    onClick={() => onChoose(item)}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-3 border-t px-3 py-2 text-sm transition-colors first:border-t-0",
                      "data-active:bg-accent data-active:text-accent-foreground",
                      blocked && "cursor-not-allowed",
                      item.kind === "back" && "text-muted-foreground",
                    )}
                  >
                    {item.kind === "back" ? (
                      <>
                        <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
                        <span className="shrink-0 font-medium">{item.back.label}</span>
                        {item.back.detail ? <span className="ml-auto min-w-0 truncate text-xs">{item.back.detail}</span> : null}
                      </>
                    ) : (
                      <>
                        <div className={cn("flex min-w-0 flex-1 items-center gap-3", blocked && pendingKey !== item.key && "opacity-50")}>
                          {renderOption(item.option)}
                        </div>
                        {pendingKey === item.key ? <Spinner className="text-primary" /> : null}
                      </>
                    )}
                  </motion.li>
                );
              })}
            </motion.ul>
          ) : null}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/**
 * 候选行的常用内容：缩略图加两行文字（主名、副名），文字过长时截断并保留完整 `title`。
 * `trailing` 放行尾的标记（「已被选择」、会员专享徽章、年份）。
 */
export function SearchOptionContent({
  media,
  title,
  subtitle,
  trailing,
}: {
  media?: ReactNode;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
}) {
  return (
    <>
      {media}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium" title={title}>{title}</span>
        {subtitle ? <span className="block truncate text-xs text-muted-foreground" title={subtitle}>{subtitle}</span> : null}
      </span>
      {trailing ? <span className="shrink-0 text-xs text-muted-foreground">{trailing}</span> : null}
    </>
  );
}
