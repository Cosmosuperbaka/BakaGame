import { useEffect, useState } from "react";
import { useAdminQuery, type AdminQuery } from "@/hooks/UseAdminQuery";
import { IDLE_SEARCH_MS } from "@/hooks/UseIdleSearch";

/** 值稳定 `delay` 毫秒后才跟上：输入框连续敲字时，下游的查询不逐字触发。初值立即生效。 */
export function useDebouncedValue<T>(value: T, delay = IDLE_SEARCH_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(settled, value)) return;
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, settled, delay]);
  return settled;
}

interface Page<T> {
  items: T[];
  total: number;
}

/**
 * 后台分页列表：筛选条件变化时自动回到第一页，翻页只改偏移。
 * 偏移记着自己属于哪组筛选，筛选一变就不再生效，不需要在每个筛选控件里手写「回到第一页」，
 * 也不会有挂载后的计时器把刚翻到的页弹回去。`filters` 里没有值的项请不要放进去（用展开写法省略）。
 */
export function useAdminList<F extends object, T>({
  name,
  filters,
  limit,
  fallback,
  fetch,
}: {
  /** 查询的名字，与筛选和分页一起组成缓存键。 */
  name: string;
  filters: F;
  limit: number;
  fallback: string;
  fetch: (input: F & { limit: number; offset: number }) => Promise<Page<T>>;
}) {
  const filterKey = JSON.stringify(filters);
  const [paged, setPaged] = useState({ filterKey, offset: 0 });
  const offset = paged.filterKey === filterKey ? paged.offset : 0;
  const input = { ...filters, limit, offset };
  const query: AdminQuery<Page<T>> = useAdminQuery(
    `${name}:${JSON.stringify(input)}`,
    () => fetch(input),
    fallback
  );
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  return {
    query,
    items,
    total,
    /** 标题行的计数、刷新与读取中状态，直接展开给 `AdminToolbar`。 */
    toolbar: {
      count: query.data ? total : null,
      onReload: query.reload,
      loading: query.loading && Boolean(query.data),
    },
    /** 分页器的全部属性，直接展开给 `Pager`。 */
    pager: {
      offset,
      limit,
      total,
      onChange: (next: number) => setPaged({ filterKey, offset: next }),
    },
  };
}
