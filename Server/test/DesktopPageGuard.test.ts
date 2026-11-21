import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

/**
 * 桌面壳注入的页面守卫脚本（右键菜单与浏览器快捷键）：脚本内嵌在 Rust 源码里，跑不进前端测试，
 * 这里把原文取出来在隔离上下文里真跑一遍，用假事件核对哪些被取消、哪些放行。
 */
const SOURCE = readFileSync(
  resolve(import.meta.dir, "../../Desktop/src-tauri/src/page_guard.rs"),
  "utf8"
);
const SCRIPT = (() => {
  const match = /const PAGE_GUARD_JS: &str = r#"([\s\S]*?)"#;/.exec(SOURCE);
  if (!match) throw new Error("没有在 page_guard.rs 里找到页面脚本原文");
  return match[1];
})();

type Listener = (event: FakeEvent) => void;
interface FakeElement {
  nodeType: 1;
  tagName: string;
  isContentEditable?: boolean;
  parentElement: FakeElement | null;
  getAttribute: (name: string) => string | null;
}
interface FakeEvent {
  target?: FakeElement;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  defaultPrevented: boolean;
  preventDefault: () => void;
}

function harness(selectedText = "") {
  const listeners = new Map<string, Listener[]>();
  const windowObject = {
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    getSelection: () => ({
      isCollapsed: selectedText.length === 0,
      toString: () => selectedText,
    }),
  };
  runInNewContext(SCRIPT, { window: windowObject }, { filename: "page_guard.rs(js)" });
  const dispatch = (type: string, init: Omit<FakeEvent, "defaultPrevented" | "preventDefault">) => {
    const event: FakeEvent = {
      ...init,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    for (const listener of listeners.get(type) ?? []) listener(event);
    return event.defaultPrevented;
  };
  return { dispatch };
}

const element = (
  tagName: string,
  options: { type?: string; editable?: boolean; parent?: FakeElement } = {}
): FakeElement => ({
  nodeType: 1,
  tagName,
  isContentEditable: options.editable,
  parentElement: options.parent ?? null,
  getAttribute: (name) => (name === "type" ? (options.type ?? null) : null),
});

test("普通区域的右键菜单被取消", () => {
  const { dispatch } = harness();
  expect(dispatch("contextmenu", { target: element("DIV") })).toBe(true);
  expect(dispatch("contextmenu", { target: element("BUTTON") })).toBe(true);
  // 复选框不是文字输入，没有可粘贴的地方
  expect(dispatch("contextmenu", { target: element("INPUT", { type: "checkbox" }) })).toBe(true);
});

test("可编辑元素与选中了文字时放行，复制粘贴照常可用", () => {
  const { dispatch } = harness();
  expect(dispatch("contextmenu", { target: element("TEXTAREA") })).toBe(false);
  expect(dispatch("contextmenu", { target: element("INPUT") })).toBe(false);
  expect(dispatch("contextmenu", { target: element("INPUT", { type: "search" }) })).toBe(false);
  const editor = element("DIV", { editable: true });
  expect(dispatch("contextmenu", { target: element("SPAN", { parent: editor }) })).toBe(false);
  expect(harness("海豹").dispatch("contextmenu", { target: element("P") })).toBe(false);
});

test("打印、另存为与查看源代码被取消，刷新与不带修饰键的输入不受影响", () => {
  const { dispatch } = harness();
  for (const key of ["p", "P", "s", "u"]) {
    expect(dispatch("keydown", { key, ctrlKey: true })).toBe(true);
    expect(dispatch("keydown", { key, metaKey: true })).toBe(true);
  }
  expect(dispatch("keydown", { key: "r", ctrlKey: true })).toBe(false);
  expect(dispatch("keydown", { key: "F5" })).toBe(false);
  expect(dispatch("keydown", { key: "c", ctrlKey: true })).toBe(false);
  expect(dispatch("keydown", { key: "p" })).toBe(false);
  expect(dispatch("keydown", { key: "p", ctrlKey: true, altKey: true })).toBe(false);
});
