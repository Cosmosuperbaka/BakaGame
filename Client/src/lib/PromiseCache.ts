export interface PromiseCache<K, V> {
  get: (key: K) => Promise<V>;
  invalidate: (key: K) => void;
  clear: () => void;
}

/**
 * 按 key 复用同一个 Promise：在途与已成功的都复用，失败即删，下一次 get 重新发起。
 * 单键场景用 `createPromiseCache<void, V>`，读写时省略 key。
 */
export function createPromiseCache<K, V>(load: (key: K) => Promise<V>): PromiseCache<K, V> {
  const pending = new Map<K, Promise<V>>();
  return {
    get: (key) => {
      const cached = pending.get(key);
      if (cached) return cached;
      const request = load(key);
      pending.set(key, request);
      void request.catch(() => {
        pending.delete(key);
      });
      return request;
    },
    invalidate: (key) => {
      pending.delete(key);
    },
    clear: () => pending.clear(),
  };
}
