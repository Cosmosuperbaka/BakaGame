import { expect, test } from "bun:test";

import { EventLogger } from "../src/infrastructure/EventLogger";

/**
 * 事件日志写入必须保持同步：谁是卧底、猜歌的结算路径没有按房互斥，
 * 它们靠「日志等待只让出微任务、事先排好的宏任务（消息、定时器、巡检）插不进来」保证结算不被交错。
 * 日志一旦改成真的等 I/O，这条用例先红，提醒同批给结算路径补 await 之后的复核或按房串行。
 */
test("事件日志写入不让出宏任务：返回的承诺完成之前，事先排好的零延时定时器不会执行", async () => {
  const logger = new EventLogger();
  let fired = false;
  setTimeout(() => {
    fired = true;
  }, 0);

  await logger.write({
    type: "game.vote_resolved",
    createdAt: Date.UTC(2026, 3, 10),
    roomId: "Oblivionis",
    payload: { tieBreak: false, leaders: [], counts: {} },
  });
  await logger.write({
    type: "game.finished",
    createdAt: Date.UTC(2026, 3, 10),
    roomId: "Oblivionis",
  });
  expect(fired).toBe(false);

  // 对照：定时器确实排上了，让出宏任务之后会执行，用例不是空转。
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(fired).toBe(true);
});
