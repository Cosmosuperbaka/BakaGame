/**
 * 浏览器存储的安全访问：存储被禁用时取到 `window.localStorage` 本身就会抛 `SecurityError`，
 * 写满、隐私模式也会让读写抛错。这里把全部异常吞掉，调用方只看返回值：
 * 读不到是 `null`，写不进是 `false`，枚举不了是空数组。需要内存兜底或「不可用即失败」语义的
 * 调用方（标签页身份、一次性恢复门闩）靠返回值自己表达，不再各写一份 try/catch。
 */
export interface SafeStore {
  get: (key: string) => string | null;
  /** 写入成功返回 true；存储不可用或写满返回 false。 */
  set: (key: string, value: string) => boolean;
  remove: (key: string) => void;
  /** 当前全部键（可按前缀过滤）；先取快照再返回，调用方边遍历边删除是安全的。 */
  keys: (prefix?: string) => string[];
}

const createSafeStore = (pick: () => Storage): SafeStore => {
  const withStorage = <T>(action: (storage: Storage) => T, fallback: T): T => {
    try {
      if (typeof window === "undefined") return fallback;
      return action(pick());
    } catch {
      return fallback;
    }
  };
  return {
    get: (key) => withStorage((storage) => storage.getItem(key), null),
    set: (key, value) =>
      withStorage((storage) => {
        storage.setItem(key, value);
        return true;
      }, false),
    remove: (key) => withStorage((storage) => storage.removeItem(key), undefined),
    keys: (prefix = "") =>
      withStorage((storage) => {
        const found: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key?.startsWith(prefix)) found.push(key);
        }
        return found;
      }, []),
  };
};

/** 跨标签页共用、关浏览器后仍在的本机偏好。 */
export const localStore = createSafeStore(() => window.localStorage);

/** 只属于当前标签页的状态（座位凭证、标签页身份）。 */
export const sessionStore = createSafeStore(() => window.sessionStorage);
