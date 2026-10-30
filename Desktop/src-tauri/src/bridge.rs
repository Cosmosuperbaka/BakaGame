//! 壳与页面的桥接脚本（计划 P2.1 / P2.2 的对接面）。
//!
//! 这段 JS 通过 Tauri v2 的 `initialization_script` 注入：它在「全局对象已建好、HTML 还没
//! 开始解析」时执行，因此页面脚本一定能看到 `window.__BAKA_CHANNEL__`。
//!
//! 契约逐字如下（前端与服务端按这些名字对接，改名等于换协议）：
//!
//! ```text
//! window.__BAKA_CHANNEL__ = {
//!   clientType: "desktop",
//!   platform: "windows",
//!   clientVersion: string,
//!   channelTicket: string,                    // 壳签好的一次性票据；无票时为空串
//!   selfCheck(): Promise<SelfCheckReport>,        // { hardFail, softFail, keyProtection }
//! }
//! ```
//!
//! `channelTicket` 是**一次性**的：服务端 30 秒 TTL、用过即焚，所以它是「读一次就作废」的
//! 访问器属性（不是普通字符串字段），读走的同时脚本立刻向壳再要一张。票由 Rust 侧
//! `attest` 模块签发（challenge → 签名 → attest），脚本只管取与缓存。
//!
//! 页面**拿不到签名能力**：签名只在壳内部用于通道证明，由 `attest` 直接调用设备私钥，
//! 不经过本脚本。页面一旦被注入脚本，也不该能拿设备私钥对任意内容签名。
//!
//! 注入失败（非桌面环境、无 IPC、被安全策略拒）时**保持静默且不注入**，页面按 Web 处理；
//! 这是有意为之：不能注入一个永远 reject 的假通道，否则桌面用户反而进不了普通房。

/// 桥接脚本原文。刻意用 ES5 写法：初始化脚本要在 WebView2 的任何版本上都能跑，
/// 不依赖可选链、顶层 await 之类的新语法。
const BRIDGE_JS: &str = r#"(function () {
  "use strict";
  // 只在主框架、且尚无人占用这个名字时注入
  var occupied = false;
  try { occupied = !!window.__BAKA_CHANNEL__; } catch (e) { occupied = true; }
  if (occupied) { return; }
  var isTop = false;
  try { isTop = window.top === window; } catch (e) { isTop = false; }
  if (!isTop) { return; }

  // 与 Rust 侧 attest::TICKET_MARGIN_MS 同值：留出网络与页面时序余量，
  // 不把「到页面手上才过期」的票交出去
  var TICKET_MARGIN_MS = 5000;
  // 轮询只决定「壳里备好的票多久能被捡走」，真正的重新签发按票自己的到期时间走
  var TICKET_POLL_MS = 4000;

  // IPC 句柄延迟解析：初始化脚本可能跑在 Tauri 注入 __TAURI_INTERNALS__ 之前
  var resolveInvoke = function () {
    try {
      var internals = window.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === "function") {
        return function (cmd, args) { return internals.invoke(cmd, args || {}); };
      }
      var tauri = window.__TAURI__;
      if (tauri && tauri.core && typeof tauri.core.invoke === "function") {
        return function (cmd, args) { return tauri.core.invoke(cmd, args || {}); };
      }
    } catch (e) {}
    return null;
  };

  // —— 通道票据：壳签好后由脚本缓存，页面只做同步读取（`bakaChannelQuery()`）——
  var ticketValue = "";
  var ticketExpiresAt = 0;
  var ticketBusy = false;

  var ticketIsUsable = function () {
    return ticketValue.length > 0 && ticketExpiresAt - Date.now() > TICKET_MARGIN_MS;
  };

  // force=false 用于定时轮询：手里那张还能用就不向壳要新的，避免白跑一趟签发
  var requestTicket = function (force) {
    if (ticketBusy) { return; }
    if (!force && ticketIsUsable()) { return; }
    var invoke = resolveInvoke();
    if (!invoke) { return; }
    ticketBusy = true;
    try {
      invoke("baka_ticket", {}).then(function (value) {
        ticketBusy = false;
        if (value && typeof value.ticket === "string" && value.ticket.length > 0) {
          ticketValue = value.ticket;
          ticketExpiresAt = Number(value.expiresAt) || 0;
        } else {
          // 签不出票（未注册、离线、自检判死）：保持空串，页面按 Web 口径连接
          ticketValue = "";
          ticketExpiresAt = 0;
        }
      }, function () {
        ticketBusy = false;
      });
    } catch (error) {
      ticketBusy = false;
    }
  };

  var channel = {
    clientType: "desktop",
    platform: "windows",
    clientVersion: "__BAKA_CLIENT_VERSION__",
    selfCheck: function () {
      var invoke = resolveInvoke();
      if (!invoke) { return Promise.reject(new Error("桌面 IPC 不可用")); }
      try {
        return invoke("baka_self_check", {}).then(function (value) {
          if (!value ||
              Object.prototype.toString.call(value.hardFail) !== "[object Array]" ||
              Object.prototype.toString.call(value.softFail) !== "[object Array]" ||
              (value.keyProtection !== "hardware" && value.keyProtection !== "software")) {
            throw new Error("自检返回值不符合契约");
          }
          return value;
        });
      } catch (error) { return Promise.reject(error); }
    }
  };

  // 一次性票据：读一次就作废并立刻补签，第二次连接绝不会带上已被服务端消费掉的旧票。
  // 用访问器而不是普通字段——`Object.freeze` 只锁数据属性的写入，访问器每次读都会重新执行。
  Object.defineProperty(channel, "channelTicket", {
    enumerable: true,
    configurable: false,
    get: function () {
      var handed = ticketValue;
      if (handed.length > 0) {
        ticketValue = "";
        ticketExpiresAt = 0;
        requestTicket(true);
      }
      return handed;
    }
  });

  try {
    Object.defineProperty(window, "__BAKA_CHANNEL__", {
      value: Object.freeze(channel),
      enumerable: true,
      configurable: false,
      writable: false
    });
  } catch (e) {
    // defineProperty 被拒时退回直接赋值，仍然保持「页面脚本执行前已存在」
    try { window.__BAKA_CHANNEL__ = Object.freeze(channel); } catch (e2) {}
  }

  // 每次导航都会重跑这段脚本：立刻要一张（壳在导航时也预签过），之后按轮询补，
  // 保证页面任何时候同步读取都能拿到一张没用过、也没到期的票
  requestTicket(true);
  setTimeout(function () { requestTicket(true); }, 300);
  setInterval(function () { requestTicket(false); }, TICKET_POLL_MS);
})();
"#;

/// 生成注入用的脚本原文：把版本占位符换成经过滤的版本串。
pub fn build() -> String {
    let safe_version: String = crate::config::client_version()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
        .collect();
    BRIDGE_JS.replace("__BAKA_CLIENT_VERSION__", &safe_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 注入脚本里不能出现会被 `initialization_script` 截断的字符
    #[test]
    fn bridge_has_no_terminating_sequences() {
        assert!(!BRIDGE_JS.contains("\"#"));
        assert!(BRIDGE_JS.contains("__BAKA_CHANNEL__"));
        // 签名只在壳内部用于通道证明：页面可达面上不能再出现签名命令
        assert!(!BRIDGE_JS.contains("baka_sign"));
        assert!(BRIDGE_JS.contains("baka_self_check"));
        // 票据通道：契约里的名字与命令名都必须出现在脚本原文里
        assert!(BRIDGE_JS.contains("channelTicket"));
        assert!(BRIDGE_JS.contains("baka_ticket"));
    }

    /// 版本串注入后必须仍是安全的字符串字面量内容（不带引号与反斜杠）
    #[test]
    fn version_token_replaced() {
        let rendered = build();
        assert!(!rendered.contains("__BAKA_CLIENT_VERSION__"));
        let line = rendered
            .lines()
            .find(|l| l.trim_start().starts_with("clientVersion:"))
            .expect("桥接脚本必须有 clientVersion 字段");
        let value = line
            .split(':').nth(1)
            .unwrap_or_default()
            .trim()
            .trim_end_matches(',')
            .trim_matches('"')
            .to_string();
        assert!(!value.is_empty());
        assert!(!value.contains('"'));
        assert!(!value.contains('\\'));
    }
}
