import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const APPLICATION_DIR = resolve(import.meta.dir, "../src/application");

/** 裸的 `type: "event"` 字面量：形状变更时要和工厂同批手改，漏改就发出形态不同的帧。 */
const EVENT_LITERAL = /\btype:\s*["']event["']/;

const tsFiles = (): string[] =>
  readdirSync(APPLICATION_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(APPLICATION_DIR, name));

describe("应用层出封包统一经工厂构造", () => {
  it("不存在手写的 event 帧字面量", () => {
    const offenders = tsFiles()
      .filter((file) => EVENT_LITERAL.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(APPLICATION_DIR.length + 1));
    expect(offenders).toEqual([]);
  });

  it("CEE 房间与大厅封包确实从 transport/Packets 导入", () => {
    for (const name of ["CEERooms.ts", "CEEService.ts"]) {
      const source = readFileSync(join(APPLICATION_DIR, name), "utf8");
      expect(source).toContain('from "../transport/Packets"');
      expect(source.match(/createEvent\(/g)?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
