import {
  useCallback,
  useId,
  useMemo,
  useState,
  type ChangeEvent,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  type SyntheticEvent,
} from "react";
import { applyMention, filterMentionCandidates, readMentionQuery } from "@/lib/Mentions";

/** 提及候选一次最多列出的人数，超出靠继续输入收窄 */
const MENTION_LIMIT = 6;

/**
 * 聊天输入框的 @提及：光标位置决定当前是否正在写一个提及，候选随输入、光标移动与失焦同步。
 * `players` 是可被提及的人（调用方已排除自己）。输入框是提及候选的组合框：
 * 候选列表与当前高亮项经 id 关联，读屏随上下键读出高亮的名字。
 */
export function useMentionInput({
  text,
  setText,
  inputRef,
  players,
}: {
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLInputElement | null>;
  players: { id: string; name: string }[];
}) {
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const candidates = useMemo(
    () => (mention ? filterMentionCandidates(players, mention.query).slice(0, MENTION_LIMIT) : []),
    [mention, players]
  );

  const close = useCallback(() => {
    setMention(null);
    setMentionIndex(0);
  }, []);

  /** 输入时同步提及查询：光标位置决定当前是否正在写一个提及 */
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setText(next);
      setMention(readMentionQuery(next, event.target.selectionStart ?? next.length));
      setMentionIndex(0);
    },
    [setText]
  );

  /** 光标移动、选区变化时重算提及查询：光标离开 `@` 片段，候选就该收起。 */
  const handleSelect = useCallback((event: SyntheticEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    setMention((current) => {
      const next = readMentionQuery(input.value, input.selectionStart ?? input.value.length);
      return next?.query === current?.query && next?.start === current?.start ? current : next;
    });
  }, []);

  /** 选中候选：写回输入框并把光标留在名字之后 */
  const pick = useCallback(
    (name: string) => {
      if (!mention) return;
      // 光标在 `@` 之前时 slice(caret) 会把前面的文字又拼一遍，最后一道防线。
      const caret = Math.max(mention.start, inputRef.current?.selectionStart ?? text.length);
      const applied = applyMention(text, mention.start, caret, name);
      setText(applied.value);
      close();
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(applied.caret, applied.caret);
      });
    },
    [mention, text, close, setText, inputRef]
  );

  /** 候选展开时的按键：上下移动高亮，回车与 Tab 选中，Esc 收起。返回 true 表示按键已被候选消费。 */
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): boolean => {
    if (candidates.length === 0) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMentionIndex((cur) => (cur + 1) % candidates.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMentionIndex((cur) => (cur - 1 + candidates.length) % candidates.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      pick(candidates[mentionIndex].name);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return true;
    }
    return false;
  };

  return {
    candidates,
    activeIndex: mentionIndex,
    setActiveIndex: setMentionIndex,
    listId,
    optionId,
    handleChange,
    handleSelect,
    handleKeyDown,
    pick,
    close,
  };
}
