/**
 * 模块内的无载荷通知：写入方与订阅方通过函数而不是 DOM 事件名耦合，
 * 订阅返回取消函数，派发时对订阅者做快照，回调里增删订阅不影响本轮。
 */
export interface Signal {
  emit: () => void;
  subscribe: (listener: () => void) => () => void;
}

export const createSignal = (): Signal => {
  const listeners = new Set<() => void>();
  return {
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
