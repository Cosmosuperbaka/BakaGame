import type { AppEnv } from "../config/Env";
import type { EventLogger } from "../infrastructure/EventLogger";

/**
 * 配了持久化凭据却没有显式注入部署环境标记：环境被推测成 development，
 * 生产必填校验与安全 Cookie 都不会生效。这里不拒启（遥测门已对带凭据的遥测拒启），
 * 只在启动时记一次告警，让漏配在日志里可见而不是静默。
 * 同一进程只记一次：节流窗口取到不可能被走完。
 */
export const warnMissingDeploymentMarker = (env: AppEnv, logger: EventLogger): void => {
  if (env.deploymentMarkerExplicit !== false || !env.databaseUrl) return;
  logger.warnThrottled(
    "startup.deployment_marker_missing",
    Number.MAX_SAFE_INTEGER,
    "未显式注入部署环境标记（DEPLOYMENT_ENVIRONMENT），已配置数据库却按 development 运行：" +
      "生产必填校验与安全 Cookie 不会生效；生产实例请显式注入 production"
  );
};
