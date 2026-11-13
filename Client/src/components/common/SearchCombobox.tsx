import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AnimatePresence, motion } from "framer-motion";
import { Search } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import {
  SearchPanel,
  type SearchBack,
  type SearchItem,
  type SearchStatus,
} from "@/components/common/search/SearchPanel";
import { popover } from "@/lib/Motion";
import { cn } from "@/lib/Utils";

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
  /** Agent 操作追踪：输入框与结果行的控件 id 前缀（结果按 `.result.<index>` 编号）。 */
  agentControlId?: string;
  agentControlPrefix?: string;
}

/**
 * 组合框的高亮与键盘：上下键在候选间循环移动，回车选中高亮项，没有高亮时回车走 `onSubmit`。
 * 高亮跟着这一批候选走：换了一批或列表变短，高亮回到「无」，不会落在别的候选上。
 */
function useComboboxNavigation<T>({
  items,
  listKey,
  open,
  optionId,
  onChoose,
  onEngage,
  onSubmit,
}: {
  items: SearchItem<T>[];
  listKey: string;
  open: boolean;
  optionId: (index: number) => string;
  onChoose: (item: SearchItem<T>) => void;
  /** 键盘操作让面板展开（方向键叫出、回车搜索） */
  onEngage: () => void;
  onSubmit?: () => void;
}) {
  const [active, setActive] = useState({ listKey, index: -1 });
  const activeIndex = active.listKey === listKey && active.index < items.length ? active.index : -1;

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
      onEngage();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const start = step > 0 ? 0 : items.length - 1;
      highlight(activeIndex < 0 ? start : (activeIndex + step + items.length) % items.length, true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = open && activeIndex >= 0 ? items[activeIndex] : undefined;
      if (item) onChoose(item);
      else {
        onEngage();
        onSubmit?.();
      }
    }
  };

  return { activeIndex, highlight, onKeyDown };
}

/**
 * 浮动搜索框：结果面板浮在下方内容之上，不把页面往下挤。
 * 面板随焦点进出：输入框（或右侧按钮）获得焦点且有内容可显示时展开，焦点离开、按 Esc 或点外面就收起，不设关闭按钮；
 * 再次聚焦时旧结果原样回来。点整行即选中，上下键移动高亮、回车选中，没有高亮时回车走 `onSubmit`。
 * 选中后面板不自己收起：调用处提交成功后清空结果，面板随之退场；提交失败时结果还在，可以换一个再选。
 * 输入框窄于 14rem 时，右侧按钮整组换到下一行并均分整宽，不把输入框挤得只剩几个字。
 * 面板走 Portal，所在区域滚动或裁切（游戏区、弹窗）都不会截断它；锚定整条搜索栏，宽度与之一致，按钮换行后面板也落在按钮之下、
 * 不盖住它们。窄屏上至少取 20rem（不超出视口），由碰撞避让推回屏内；下方空间不够时翻到上方。
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
  agentControlId,
  agentControlPrefix,
}: SearchComboboxProps<T>) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [engaged, setEngaged] = useState(false);

  const items: SearchItem<T>[] = [
    ...(back ? [{ kind: "back" as const, key: "__back", back }] : []),
    ...options.map((option) => ({ kind: "option" as const, key: getKey(option), option })),
  ];
  const open = engaged && !disabled && (items.length > 0 || status !== null);
  const optionId = (index: number) => `${listId}-option-${index}`;

  const unavailable = (item: SearchItem<T>) =>
    item.kind === "option" && (pendingKey !== null || Boolean(isOptionDisabled?.(item.option)));

  const choose = (item: SearchItem<T>) => {
    if (item.kind === "back") item.back.onBack();
    else if (!unavailable(item)) onSelect(item.option);
  };

  const { activeIndex, highlight, onKeyDown } = useComboboxNavigation({
    items,
    listKey,
    open,
    optionId,
    onChoose: choose,
    onEngage: () => setEngaged(true),
    onSubmit,
  });

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setEngaged(false);
      }}
    >
      <Popover.Anchor asChild>
        <div
          ref={rootRef}
          className={cn("flex min-w-0 flex-wrap gap-2", className)}
          onFocus={() => setEngaged(true)}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && rootRef.current?.contains(next)) return;
            setEngaged(false);
          }}
        >
          <div
            data-disabled={disabled || undefined}
            className={cn(
              // 输入框与按钮组的放大比悬殊：同一行时余宽几乎全归输入框；按钮组换行后独占一行，按钮再均分。
              "field-frame flex h-10 min-w-0 grow-[999] basis-56 items-center gap-2 rounded-md bg-background px-3",
              disabled && "opacity-50"
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
              data-agent-control={agentControlId}
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
          {actions ? (
            // 按下搜索按钮不让按钮抢焦点，焦点留在（或回到）输入框：光标不丢，面板也不会因为失焦先收起再展开。
            <div
              className="flex grow gap-2 [&>*]:grow"
              onMouseDown={(event) => {
                event.preventDefault();
                inputRef.current?.focus();
              }}
            >
              {actions}
            </div>
          ) : null}
        </div>
      </Popover.Anchor>
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
                if (event.target instanceof Node && rootRef.current?.contains(event.target))
                  event.preventDefault();
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
                  agentControlPrefix={agentControlPrefix}
                  renderOption={renderOption}
                  onHighlight={(index) => {
                    if (index !== activeIndex) highlight(index, false);
                  }}
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
