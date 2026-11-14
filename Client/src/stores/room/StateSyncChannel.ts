import { consumeStateSync } from "@/lib/StateSync";

/** 单条状态通道的协议基线：修订号与完整状态只在这里流转，何时写展示态由调用方决定。 */
export interface StateSyncBaseline<T> {
  /** 消费一条同步推送；返回 null 表示需要全量，且已按在途去重与欠账口径发起或登记。 */
  consume: (payload: unknown) => T | null;
  baseline: () => T | null;
  /** 安装 ACK 首屏状态为基线，修订号随之作废。 */
  adopt: (state: T | null) => void;
}

export interface StateSyncChannel<TSnapshot, TPrivate> {
  snapshot: StateSyncBaseline<TSnapshot>;
  privateState: StateSyncBaseline<TPrivate>;
  /** 作废两条通道的基线、修订号、在途标记与欠账。 */
  reset: () => void;
  /** 只作废修订号、保留基线：旧连接的版本号对新连接没有意义，但基线仍是最新房态。 */
  clearRevisions: () => void;
  /** 取走欠账标记；调用方在凭据写回后再决定是否 flushDeferred。 */
  takeDeferred: () => boolean;
  /** 补发欠账的全量请求，仍走在途去重与暂缓口径。 */
  flushDeferred: () => void;
}

/**
 * 一个运行时持有快照与私有态两条通道，共用一个全量请求在途标记：
 * 服务端的全量应答会同时校准两条通道，在途期间重复请求没有意义。
 */
export function createStateSyncChannel<TSnapshot, TPrivate>(options: {
  requestFull: () => Promise<unknown>;
  /** 为 true 时全量请求只记欠账不发出（如 CEE 入房在途且凭据未写回）。 */
  defer: () => boolean;
  onError: (error: unknown) => void;
}): StateSyncChannel<TSnapshot, TPrivate> {
  const lanes = {
    snapshot: { state: null as TSnapshot | null, revision: undefined as number | undefined },
    privateState: { state: null as TPrivate | null, revision: undefined as number | undefined },
  };
  let pending = false;
  let deferred = false;

  const requestFullSync = () => {
    if (pending) return;
    if (options.defer()) {
      deferred = true;
      return;
    }
    pending = true;
    void options
      .requestFull()
      .catch(options.onError)
      .finally(() => {
        pending = false;
      });
  };

  const baselineOf = <T>(lane: {
    state: T | null;
    revision: number | undefined;
  }): StateSyncBaseline<T> => ({
    consume: (payload) => {
      const result = consumeStateSync(lane.state, lane.revision, payload);
      if (result.needsFullSync || !result.state) {
        requestFullSync();
        return null;
      }
      lane.revision = result.revision;
      lane.state = result.state;
      return lane.state;
    },
    baseline: () => lane.state,
    adopt: (state) => {
      lane.state = state;
      lane.revision = undefined;
    },
  });

  return {
    snapshot: baselineOf(lanes.snapshot),
    privateState: baselineOf(lanes.privateState),
    reset: () => {
      lanes.snapshot.state = null;
      lanes.snapshot.revision = undefined;
      lanes.privateState.state = null;
      lanes.privateState.revision = undefined;
      pending = false;
      deferred = false;
    },
    clearRevisions: () => {
      lanes.snapshot.revision = undefined;
      lanes.privateState.revision = undefined;
    },
    takeDeferred: () => {
      const value = deferred;
      deferred = false;
      return value;
    },
    flushDeferred: requestFullSync,
  };
}
