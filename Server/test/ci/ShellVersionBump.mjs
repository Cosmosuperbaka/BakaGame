import test from "node:test";
import assert from "node:assert/strict";
import {
  SHELLS,
  changedSince,
  resolveBaseline,
  shellVersionViolations,
  versionAt,
} from "./support/ShellVersionBump.mjs";

/**
 * 壳版本号门禁：桌面壳与移动壳的源码有改动，对应的版本号文件就必须跟着抬。
 *
 * 规范（Server/docs/ClientChannel.md）要求原生侧的修复连同版本号一起发，否则修复前装的壳
 * 永远收不到「有新版本」。此前只有人记得，没有机器检查。
 */

const DESKTOP_SRC = "Desktop/src-tauri/src/Main.rs";
const ANDROID_SRC = "Mobile/android/app/src/main/java/Main.kt";
const versions = (map) => (file) => map[file];
const DESKTOP_VERSION = "Desktop/src-tauri/Cargo.toml";
const ANDROID_VERSION = "Mobile/package.json";

test("桌面壳源码有改动而版本没抬：报红并指明文件与自动发布后果", () => {
  const problems = shellVersionViolations(
    [DESKTOP_SRC],
    versions({ [DESKTOP_VERSION]: "0.1.3" }),
    versions({ [DESKTOP_VERSION]: "0.1.3" })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Desktop\/src-tauri\/Cargo\.toml/);
  assert.match(problems[0], /自动构建并发布新安装包/);
});

test("移动壳源码有改动而版本没抬：报红", () => {
  const problems = shellVersionViolations(
    [ANDROID_SRC],
    versions({ [ANDROID_VERSION]: "0.1.3" }),
    versions({ [ANDROID_VERSION]: "0.1.3" })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Mobile\/package\.json/);
});

test("版本已抬、或改动不在壳源码目录里：通过", () => {
  assert.deepEqual(
    shellVersionViolations(
      [DESKTOP_SRC, ANDROID_SRC],
      versions({ [DESKTOP_VERSION]: "0.1.3", [ANDROID_VERSION]: "0.1.3" }),
      versions({ [DESKTOP_VERSION]: "0.1.4", [ANDROID_VERSION]: "0.2.0" })
    ),
    []
  );
  assert.deepEqual(
    shellVersionViolations(
      ["Desktop/README.md", "Desktop/src-tauri/tests/Smoke.rs", "Client/src/App.tsx"],
      versions({}),
      versions({})
    ),
    []
  );
});

test("只抬了一个壳的版本：另一个壳仍然报红", () => {
  const problems = shellVersionViolations(
    [DESKTOP_SRC, ANDROID_SRC],
    versions({ [DESKTOP_VERSION]: "0.1.3", [ANDROID_VERSION]: "0.1.3" }),
    versions({ [DESKTOP_VERSION]: "0.1.4", [ANDROID_VERSION]: "0.1.3" })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /移动壳/);
});

test("版本号读不出来时按没抬处理（不放水）", () => {
  const problems = shellVersionViolations(
    [DESKTOP_SRC],
    versions({ [DESKTOP_VERSION]: "0.1.3" }),
    versions({})
  );
  assert.equal(problems.length, 1);
});

test("版本号解析器能读出两个壳当前的版本（防声明形式变了而门禁空转）", () => {
  for (const shell of SHELLS) {
    const found = versionAt("HEAD", shell);
    assert.match(found ?? "", /^\d+\.\d+\.\d+$/, `${shell.versionFile} 解析不到版本号`);
  }
});

test("与上一个提交相比，壳源码改动必须伴随版本号抬升", (t) => {
  const baseline = resolveBaseline();
  if (!baseline.base) {
    const reason = `跳过壳版本号门禁：${baseline.reason}`;
    console.log(reason);
    t.skip(reason);
    return;
  }
  const changed = changedSince(baseline.base);
  const problems = shellVersionViolations(
    changed,
    (file) =>
      versionAt(
        baseline.base,
        SHELLS.find((shell) => shell.versionFile === file)
      ),
    (file) =>
      versionAt(
        "HEAD",
        SHELLS.find((shell) => shell.versionFile === file)
      )
  );
  assert.deepEqual(problems, []);
});
