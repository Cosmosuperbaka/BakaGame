import type { PublicStatusLevel } from "../shared/Status";

/**
 * 外部可用性监测适配器：状态页只消费归一化后的等级，不关心上游是哪家监测服务。
 * 换服务只替换实现，路由与页面不动。
 */
export interface ExternalStatusProbe {
  /** 返回 `null` 表示暂时无法确认（未接入、上游不可达或响应不可解析）。 */
  read(): Promise<PublicStatusLevel | null>;
}

/** 未配置外部监测时的缺省适配器：不请求任何外部服务，页面把外部监测显示为「未知」。 */
export class MockExternalStatusProbe implements ExternalStatusProbe {
  async read(): Promise<PublicStatusLevel | null> {
    return null;
  }
}
