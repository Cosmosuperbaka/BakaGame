// 真实 Sentry SDK 的唯一落点。入口脚本不静态引用它（Replay、Tracing 合计占入口脚本约三成），
// 由 Sentry.ts 在页面空闲时动态加载；其余代码只经 Sentry.ts 的门面与 driver 接缝使用遥测。
import * as Sentry from "@sentry/react";
import {
  notifyClientTelemetryEgressFailure,
  wrapTelemetryTransport,
  type SentrySdkDriver,
} from "@/lib/Sentry";

export const createSentryDriver = (): SentrySdkDriver => ({
  init: (options) =>
    Sentry.init({
      ...options,
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
        Sentry.consoleLoggingIntegration({ levels: ["error", "warn"] }),
      ],
    }),
  captureException: (error) => Sentry.captureException(error),
  withScope: (callback) => Sentry.withScope(callback),
  log: (level, message, attributes) => {
    const attrs = attributes as never;
    if (level === "error") Sentry.logger.error(message, attrs);
    else if (level === "warning") Sentry.logger.warn(message, attrs);
    else Sentry.logger.info(message, attrs);
  },
  metricCount: (name, value, attributes) => Sentry.metrics.count(name, value, { attributes }),
  metricDistribution: (name, value, attributes) =>
    Sentry.metrics.distribution(name, value, { unit: "millisecond", attributes }),
  startSpan: async (name, attributes, callback) =>
    Sentry.startSpan({ name, op: "bakagame.client", attributes }, callback),
  makeTransport: (options) =>
    wrapTelemetryTransport(Sentry.makeFetchTransport(options), notifyClientTelemetryEgressFailure),
});
