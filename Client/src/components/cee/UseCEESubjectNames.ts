import { useEffect, useRef, useState } from "react";
import { useCEEStore } from "@/stores/UseCEEStore";

/**
 * 追加作品的名称：设置里只存编号，搜索添加时顺手记下名字；导入、预设或非房主看到的编号经 `cee.subject.lookup` 补齐。
 * 每个编号只查一次，查不到的保持「作品 #编号」。
 */
export function useCEESubjectNames(ids: number[]) {
  const [names, setNames] = useState<Record<number, string>>({});
  const requested = useRef(new Set<number>());
  const key = ids.filter((id) => !(id in names)).join(",");
  useEffect(() => {
    // 已经发出过的编号不再查；查不到的不会进 names，靠这里挡住重复请求。
    const subjectIds = key
      ? key
          .split(",")
          .map(Number)
          .filter((id) => !requested.current.has(id))
      : [];
    if (!subjectIds.length) return;
    subjectIds.forEach((id) => requested.current.add(id));
    let alive = true;
    void useCEEStore
      .getState()
      .sendCommand("cee.subject.lookup", { subjectIds })
      .then(({ results }) => {
        if (alive)
          setNames((current) => ({
            ...current,
            ...Object.fromEntries(
              results.map((subject) => [subject.id, subject.nameCn || subject.name])
            ),
          }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key]);
  const remember = (id: number, name: string) =>
    setNames((current) => ({ ...current, [id]: name }));
  return { nameOf: (id: number) => names[id] ?? `作品 #${id}`, remember };
}
