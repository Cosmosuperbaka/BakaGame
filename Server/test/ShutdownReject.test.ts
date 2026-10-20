import { expect, test } from "bun:test";

import {
  SHUTDOWN_REJECT_CODE,
  SHUTDOWN_REJECT_MESSAGE,
  shutdownRejection,
  systemRoutes,
} from "../src/transport/routes/System";

/**
 * 停机闸门的行为契约：`/readyz` 的 503 只让上游停止分配新流量，进程内的新握手照样会完成升级。
 *  transport/App.ts 的 WS 升级闸门消费这里导出的谓词与响应（见停机契约文档），
 * 本文件锁住「同一份停机状态 → 摘流 + 拒新连接」这一对结果，以及未停机时必须放行。
 */
const probe = (isShuttingDown: (() => boolean) | undefined) =>
  systemRoutes({ isShuttingDown }).handle(new Request("http://localhost/readyz"));

test("未停机与未注入停机状态都必须放行：闸门不得把正常流量锁死", () => {
  expect(shutdownRejection(undefined)).toBeUndefined();
  expect(shutdownRejection(() => false)).toBeUndefined();
});

test("停机中拒绝新握手：503 + 统一错误信封，与摘流共用同一份停机状态", async () => {
  let shuttingDown = false;
  const isShuttingDown = () => shuttingDown;
  const rejection = shutdownRejection(isShuttingDown, "trace-fixture");
  expect(rejection).toBeUndefined();
  await expect(probe(isShuttingDown).then((response) => response.status)).resolves.toBe(200);

  shuttingDown = true;
  const blocked = shutdownRejection(isShuttingDown, "trace-fixture");
  expect(blocked).toBeInstanceOf(Response);
  expect(blocked?.status).toBe(503);
  expect(blocked?.headers.get("content-type")).toContain("application/json");
  expect(await blocked?.json()).toEqual({
    error: {
      code: SHUTDOWN_REJECT_CODE,
      message: SHUTDOWN_REJECT_MESSAGE,
      traceId: "trace-fixture",
    },
  });
  // 摘流与新连接拒绝必须由同一个谓词驱动：只有一边生效时，排空窗口永远等不到「没有新连接」。
  const ready = await probe(isShuttingDown);
  expect(ready.status).toBe(503);
  expect(await ready.json()).toEqual({ status: "shutting_down", ready: false });
});

test("停机拒绝码是可判别的单一常量，不在各处各写一份字符串", () => {
  expect(shutdownRejection(() => true)?.status).toBe(503);
  expect(SHUTDOWN_REJECT_CODE).toBe("SERVICE_UNAVAILABLE");
  expect(SHUTDOWN_REJECT_MESSAGE).toContain("停机");
});
