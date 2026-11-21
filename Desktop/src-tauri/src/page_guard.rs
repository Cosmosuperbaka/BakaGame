//! 让站点在壳里更像应用、不像浏览器的页面脚本（与桥接脚本分开注入，不属于 `__BAKA_CHANNEL__` 契约）。
//!
//! - 右键菜单：WebView 自带的菜单里是「返回」「刷新」「另存为」「打印」这类浏览器操作，对游戏没有意义，
//!   拦掉；可编辑元素里与选中了文字时放行，复制、粘贴照常可用。站点自己的右键处理不受影响
//!   （只取消默认菜单，不拦事件传播）。
//! - 快捷键：打印、另存为、查看源代码这几个浏览器快捷键单独取消；刷新保留，页面缩放由壳打开的
//!   缩放快捷键负责。
//!
//! 脚本原文由服务端的 `DesktopPageGuard` 测试取出来在隔离上下文里真跑一遍。

/// 页面脚本原文。用 ES5 写法，理由同桥接脚本：初始化脚本要在各版本 WebView 上都能跑。
const PAGE_GUARD_JS: &str = r#"(function () {
  "use strict";
  var TEXT_INPUTS = ["", "text", "search", "url", "tel", "email", "password", "number"];

  var editable = function (node) {
    for (var el = node; el && el.nodeType === 1; el = el.parentElement) {
      if (el.isContentEditable) { return true; }
      if (el.tagName === "TEXTAREA") { return true; }
      if (el.tagName === "INPUT") {
        var type = String(el.getAttribute("type") || "").toLowerCase();
        return TEXT_INPUTS.indexOf(type) !== -1;
      }
    }
    return false;
  };

  var hasSelection = function () {
    try {
      var selection = window.getSelection();
      return !!selection && !selection.isCollapsed && String(selection).length > 0;
    } catch (e) { return false; }
  };

  window.addEventListener("contextmenu", function (event) {
    if (editable(event.target) || hasSelection()) { return; }
    event.preventDefault();
  }, true);

  // 打印、另存为、查看源代码；刷新（Ctrl+R、F5）与缩放不在此列
  var BLOCKED_KEYS = ["p", "s", "u"];
  window.addEventListener("keydown", function (event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) { return; }
    var key = String(event.key || "").toLowerCase();
    if (BLOCKED_KEYS.indexOf(key) !== -1) { event.preventDefault(); }
  }, true);
})();
"#;

/// 注入用的脚本原文
pub fn script() -> &'static str {
    PAGE_GUARD_JS
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只取消默认行为，不拦事件传播：站点自己的右键与快捷键处理照常收到事件
    #[test]
    fn guard_never_stops_propagation() {
        assert!(!PAGE_GUARD_JS.contains("stopPropagation"));
        assert!(!PAGE_GUARD_JS.contains("stopImmediatePropagation"));
        assert!(!PAGE_GUARD_JS.contains("\"#"));
    }

    /// 刷新保留：拦截表里只有打印、另存为与查看源代码三个键，按键判断前要求按着 Ctrl 或 ⌘
    #[test]
    fn refresh_keys_are_not_blocked() {
        assert!(PAGE_GUARD_JS.contains(r#"var BLOCKED_KEYS = ["p", "s", "u"];"#));
        assert!(PAGE_GUARD_JS
            .contains("if (!(event.ctrlKey || event.metaKey) || event.altKey) { return; }"));
    }
}
