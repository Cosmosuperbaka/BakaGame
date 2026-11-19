import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 热更新来源收口依赖「原生侧写死的站点主机」与「桥接脚本的默认接口基址」是同一个主机：
 * 两处各写一份，漂移的后果是正常用户的热更新被静默拒掉（或来源范围悄悄变宽），
 * 所以在脚本测试里逐字对账。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, "..");
const read = (relative) => fs.readFileSync(path.join(mobile, relative), "utf8");

test("原生热更新的站点主机与桥接脚本的默认接口基址是同一个主机", () => {
  const bridge = /DEFAULT_API_ORIGIN\s*=\s*"https:\/\/([^"/]+)"/.exec(
    read("bridge/baka-bridge.js")
  );
  const native = /const val SITE_HOST\s*=\s*"([^"]+)"/.exec(
    read("android/app/src/main/java/website/baka/game/update/HotUpdatePolicy.kt")
  );
  assert.ok(bridge, "桥接脚本里没找到 DEFAULT_API_ORIGIN");
  assert.ok(native, "HotUpdatePolicy.kt 里没找到 SITE_HOST");
  assert.equal(native[1], bridge[1]);
});
