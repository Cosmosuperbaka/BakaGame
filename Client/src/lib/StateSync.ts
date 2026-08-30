import type {
  StatePatchOperation,
  StatePathSegment,
  StateSyncPayload,
} from "@/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function isStateSyncPayload<T>(value: unknown): value is StateSyncPayload<T> {
  if (!isRecord(value) || (value.mode !== "full" && value.mode !== "patch")) return false;
  if (typeof value.revision !== "number") return false;
  return value.mode === "full"
    ? "state" in value
    : typeof value.baseRevision === "number" && Array.isArray(value.operations);
}

const getParent = (root: unknown, path: StatePathSegment[]) => {
  let parent = root as Record<string | number, unknown>;
  for (const segment of path.slice(0, -1)) {
    const next = parent[segment];
    if (!next || typeof next !== "object") {
      throw new Error("状态补丁路径不存在");
    }
    parent = next as Record<string | number, unknown>;
  }
  return parent;
};

export function applyStatePatch<T>(current: T, operations: StatePatchOperation[]): T {
  let result = structuredClone(current) as unknown;
  for (const operation of operations) {
    if (operation.path.length === 0) {
      if (operation.op === "delete") throw new Error("不能删除状态根节点");
      result = structuredClone(operation.value);
      continue;
    }

    const parent = getParent(result, operation.path);
    const key = operation.path.at(-1)!;
    if (operation.op === "delete") {
      if (Array.isArray(parent) && typeof key === "number") {
        parent.splice(key, 1);
      } else {
        delete parent[key];
      }
    } else {
      parent[key] = structuredClone(operation.value);
    }
  }
  return result as T;
}

export interface StateSyncResult<T> {
  state?: T;
  revision?: number;
  needsFullSync: boolean;
}

export function consumeStateSync<T>(
  current: T | null,
  currentRevision: number | undefined,
  payload: unknown,
): StateSyncResult<T> {
  if (!isStateSyncPayload<T>(payload)) {
    return { needsFullSync: true };
  }
  if (payload.mode === "full") {
    return { state: payload.state, revision: payload.revision, needsFullSync: false };
  }
  if (!current || currentRevision !== payload.baseRevision) {
    return { needsFullSync: true };
  }
  try {
    return {
      state: applyStatePatch(current, payload.operations),
      revision: payload.revision,
      needsFullSync: false,
    };
  } catch {
    return { needsFullSync: true };
  }
}
