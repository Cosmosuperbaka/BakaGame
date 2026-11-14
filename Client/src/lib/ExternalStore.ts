import { useSyncExternalStore } from "react";

export interface ExternalStore<T> {
  get: () => T;
  /** 写入并通知订阅者。 */
  set: (next: T) => void;
  /** 只写值：通知时机由调用方掌握（副作用做完再 emit，或在渲染期读取时根本不通知）。 */
  write: (next: T) => void;
  /** 值本身没变、但由它派生的东西变了时，让订阅者重读。 */
  emit: () => void;
  subscribe: (listener: () => void) => () => void;
  use: () => T;
}

/** React 之外也要同步读写的外部状态；服务端快照取初值。 */
export function createExternalStore<T>(initial: T): ExternalStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const get = () => value;
  const write = (next: T) => {
    value = next;
  };
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  function use(): T {
    return useSyncExternalStore(subscribe, get, () => initial);
  }
  return {
    get,
    set: (next) => {
      write(next);
      emit();
    },
    write,
    emit,
    subscribe,
    use,
  };
}
