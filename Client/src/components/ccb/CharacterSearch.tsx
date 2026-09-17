import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/Input";
import { useCCBStore } from "@/stores/UseCCBStore";
import { cn } from "@/lib/Utils";
import type { CCBCharacterSearchResult } from "@/types";

/**
 * 服务端 `ccb.character.search` 的应答。
 * 必须是 `type` 而非 `interface`：`sendCommand` 的泛型约束是 `Record<string, unknown>`，
 * interface 拿不到隐式索引签名（TS2344）。
 */
type SearchResponse = { results: CCBCharacterSearchResult[] };

const DEBOUNCE_MS = 250;

interface CharacterSearchProps {
  /** 已被猜过的角色（自己猜过的，或全局 BP 下别人猜过的），置灰不可选。 */
  pickedIds: Set<number>;
  disabled?: boolean;
  onSelect: (character: CCBCharacterSearchResult) => void;
}

/**
 * 角色搜索。检索走服务端（本地数据集），**客户端不接触数据库**。
 *
 * 服务端有两套检索：三个字以上走 FTS5 trigram，**短于三字自动回退 LIKE** ——
 * 所以「牧濑」这种两字简称是能命中的，前端不需要特殊处理。
 *
 * ⚠️ 所有 `setState` 都在**防抖回调里**（异步），effect 体内不同步 setState ——
 * 这是 `react-hooks/set-state-in-effect` 的硬要求，也是为了不触发级联渲染。
 */
export function CharacterSearch({ pickedIds, disabled, onSelect }: CharacterSearchProps) {
  const sendCommand = useCCBStore((state) => state.sendCommand);
  const [keyword, setKeyword] = useState("");
  const [fetched, setFetched] = useState<{
    query: string;
    results: CCBCharacterSearchResult[];
  }>({ query: "", results: [] });
  const [searching, setSearching] = useState(false);
  const listId = useId();
  // 只认最后一次请求的结果，避免慢响应覆盖快响应。
  const requestSeq = useRef(0);

  useEffect(() => {
    const query = keyword.trim();
    if (query.length === 0) return;
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    const timer = setTimeout(() => {
      setSearching(true);
      void sendCommand<SearchResponse>("ccb.character.search", { keyword: query })
        .then((response) => {
          if (requestSeq.current === seq) setFetched({ query, results: response.results ?? [] });
        })
        .catch(() => {
          if (requestSeq.current === seq) setFetched({ query, results: [] });
        })
        .finally(() => {
          if (requestSeq.current === seq) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [keyword, sendCommand]);

  const handleSelect = useCallback(
    (character: CCBCharacterSearchResult) => {
      if (pickedIds.has(character.id)) return;
      onSelect(character);
      // 清空输入即收起列表，不需要额外的「打开」状态。
      setKeyword("");
      setFetched({ query: "", results: [] });
    },
    [onSelect, pickedIds],
  );

  const query = keyword.trim();
  // 结果只在自己就是当前关键词的结果时才展示，避免旧响应闪现。
  const results = fetched.query === query ? fetched.results : [];
  const visible = results.slice(0, 12);
  const showList = query.length > 0 && visible.length > 0;
  const showEmpty = query.length > 0 && fetched.query === query && !searching && visible.length === 0;

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={keyword}
        disabled={disabled}
        placeholder={disabled ? "本局你不能再猜了" : "搜索角色名（支持日文 / 中文 / 别名）"}
        className="pl-8"
        aria-expanded={showList}
        aria-controls={listId}
        onChange={(event) => setKeyword(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && visible.length > 0) {
            event.preventDefault();
            handleSelect(visible[0]!);
          }
          if (event.key === "Escape") setKeyword("");
        }}
      />

      {showList ? (
        <ul
          id={listId}
          role="listbox"
          className="scrollbar-hidden absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {visible.map((character) => {
            const picked = pickedIds.has(character.id);
            return (
              <li key={character.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  aria-disabled={picked}
                  disabled={picked}
                  onClick={() => handleSelect(character)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                    picked ? "cursor-not-allowed opacity-45" : "hover:bg-accent",
                  )}
                >
                  {character.imageUrl ? (
                    <img
                      src={character.imageUrl}
                      alt=""
                      loading="lazy"
                      className="h-8 w-8 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-muted text-xs text-muted-foreground">
                      ?
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {character.nameCn || character.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {character.name}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {character.popularity}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {showEmpty ? (
        <p className="absolute z-20 mt-1 w-full rounded-md border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-md">
          没有匹配的角色
        </p>
      ) : null}
    </div>
  );
}
