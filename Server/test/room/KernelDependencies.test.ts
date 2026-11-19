import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * 内核的依赖方向是设计本身：内核不认识任何玩法，内部只有「座位绑定 → 房主策略」一条运行时边，
 * 其余模块只经 `import type` 共享类型底座。新增的 import 一旦越界，这里先红。
 */

const SRC = join(import.meta.dir, "../../src");
const KERNEL_DIR = "application/room";

/** 内核允许依赖的外部模块（相对 src，不带扩展名）。 */
const ALLOWED_EXTERNAL = [
  /^shared\/(Model|Protocol|RoomSnapshot)$/,
  /^domain\/(Errors|Rules|GameRecord|AdminRoom|TestRooms)$/,
  /^config\/Constants$/,
  /^infrastructure\/(RateLimiter|SensitiveText)$/,
  /^application\/(ConnectionRegistry|LobbyFanout|TabSeat)$/,
  /^transport\/Packets$/,
];

/** 内核内部允许的运行时（非 type）边。 */
const ALLOWED_INTERNAL_VALUE_EDGES = new Set(["SeatBinding->HostPolicy"]);

interface ImportEdge {
  target: string;
  typeOnly: boolean;
}

const importsOf = (relativeFile: string): ImportEdge[] => {
  const text = readFileSync(join(SRC, relativeFile), "utf8");
  const edges: ImportEdge[] = [];
  for (const match of text.matchAll(/^import\s+(type\s+)?[^;]*?\s+from\s+"([^"]+)";/gm)) {
    const specifier = match[2];
    if (!specifier.startsWith(".")) continue;
    const target = posix.normalize(posix.join(posix.dirname(relativeFile), specifier));
    edges.push({ target, typeOnly: Boolean(match[1]) });
  }
  return edges;
};

const kernelFiles = readdirSync(join(SRC, KERNEL_DIR))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => `${KERNEL_DIR}/${name}`);

describe("内核依赖方向", () => {
  test("内核文件齐全", () => {
    expect(kernelFiles.map((file) => posix.basename(file, ".ts")).sort()).toEqual([
      "ChatLog",
      "CommandTable",
      "HostPolicy",
      "IdCounter",
      "RoomCore",
      "RoomIdReservations",
      "RoomJanitor",
      "RoomPasswordGate",
      "RoomPublisher",
      "RoomSnapshotCodec",
      "RoomSummaries",
      "RoomTimers",
      "SeatBinding",
    ]);
  });

  test.each(kernelFiles)("%s 不越界：不碰玩法文件，内部只有一条运行时边", (file) => {
    const self = posix.basename(file, ".ts");
    for (const edge of importsOf(file)) {
      if (edge.target.startsWith(`${KERNEL_DIR}/`)) {
        const peer = posix.basename(edge.target);
        if (edge.typeOnly) {
          // 类型底座是唯一的类型汇聚点；它自己只引用占号的类型。
          const allowed =
            peer === "RoomCore" || (self === "RoomCore" && peer === "RoomIdReservations");
          expect(allowed ? peer : `${self} -> ${peer}（类型）`).toBe(peer);
        } else {
          expect(
            ALLOWED_INTERNAL_VALUE_EDGES.has(`${self}->${peer}`) ? peer : `${self} -> ${peer}`
          ).toBe(peer);
        }
        continue;
      }
      const allowed = ALLOWED_EXTERNAL.some((pattern) => pattern.test(edge.target));
      expect(allowed ? edge.target : `${self} 越界依赖 ${edge.target}`).toBe(edge.target);
    }
  });

  test("两个领域文件只依赖共享纯值", () => {
    for (const file of ["domain/TestRooms.ts", "domain/Visibility.ts"]) {
      for (const edge of importsOf(file)) expect(edge.target).toBe("shared/ModelValues");
    }
  });

  test("依赖解析本身可用：座位绑定确实引用了房主策略", () => {
    expect(importsOf(`${KERNEL_DIR}/SeatBinding.ts`)).toContainEqual({
      target: `${KERNEL_DIR}/HostPolicy`,
      typeOnly: false,
    });
  });
});
