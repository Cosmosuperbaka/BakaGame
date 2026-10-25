import type { PublicStatusLevel, UpstreamStatusComponentId } from "../shared/Status";

/** 单个上游接口的一次读数：等级与（拿得到时的）平均响应耗时。 */
export interface ExternalMonitorReading {
  level: PublicStatusLevel;
  /** 毫秒；监测服务未给出响应耗时时为 null。 */
  latencyMs: number | null;
}

/**
 * 外部可用性监测适配器：状态页按上游组件消费各自的读数，
 * 不关心上游是哪家监测服务。换服务只替换实现，路由与页面不动。
 */
export interface ExternalStatusProbe {
  /**
   * 返回 `null` 表示暂时无法确认（未接入、上游不可达或响应不可解析）；
   * 返回对象时，未映射到 monitor 的上游组件不在 `components` 里，页面读作未知。
   */
  read(): Promise<ExternalStatusReading | null>;
}

export type ExternalStatusReading = Partial<Record<UpstreamStatusComponentId, ExternalMonitorReading>>;

/** 未配置外部监测时的缺省适配器：不请求任何外部服务，页面把上游接口显示为「未知」。 */
export class MockExternalStatusProbe implements ExternalStatusProbe {
  async read(): Promise<ExternalStatusReading | null> {
    return null;
  }
}
