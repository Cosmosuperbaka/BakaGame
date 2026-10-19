/* eslint-disable */
// BakaGame 移动端通道桥接（唯一一处前端桥接，Client 源码零改动）。
// 由 scripts/prepare-web.mjs 注入到 index.html 的 <head> 最前，classic 脚本、
// 先于 Client 应用自身的 module 脚本执行，保证 window.__BAKA_CHANNEL__ 就绪时序。
//
// 契约（与服务端/桌面端逐字对齐，勿改字段名；约束见仓库根 Server/docs/ClientChannel.md）：
//   window.__BAKA_CHANNEL__ = {
//     clientType: "mobile", platform: "android", clientVersion: string,
//     channelTicket: string,                              // 壳签好的一次性票据；无票时为空串
//     sign(challenge: string): Promise<string>,           // base64 DER 签名
//     selfCheck(): Promise<SelfCheckReport>,              // 见下
//   }
//   SelfCheckReport = { hardFail: string[], softFail: string[], attestationLevel: "trusted" | "degraded" | "rejected" }
//
// 通道证明闭环（本文件负责，原生侧只出密钥能力）：
//   POST /api/client/challenge {clientId} → 拿 challenge
//   → Keystore 对 challenge 的原样字节签 SHA256withECDSA（base64 DER）
//   → POST /api/client/attest {clientId, challenge, signature, clientType, clientVersion, selfCheck}
//   → 拿 ticket，挂到 channelTicket 上供页面拼 ws 握手查询串。
// 票是 30 秒 TTL、用过即焚的：读一次就作废并同时补签一张，定时轮询保证页面任何时候同步
// 读取都握着一张没用过、也没到期的票。注册依旧惰性——只有页面第一次要票时才走。
(function () {
  if (window.__BAKA_CHANNEL__) return;

  var CLIENT_VERSION = "__BAKA_CLIENT_VERSION__"; // 打包时由 prepare-web.mjs 替换
  var REGISTER_PATH = "/api/client/register";
  var CHALLENGE_PATH = "/api/client/challenge";
  var ATTEST_PATH = "/api/client/attest";
  var STORAGE_KEY = "baka.channel.clientId";
  var pending = null; // 注册只成功一次的幂等承诺
  // clientId 本地缓存：注册成功后写入，服务端回 CLIENT_UNKNOWN 时清空重来
  var clientId = storageGet(STORAGE_KEY) || "";
  // 与桌面壳 attest::TICKET_MARGIN_MS 同值：离过期不足这个余量就当没有
  var TICKET_MARGIN_MS = 5000;
  // 轮询只决定「签好的票多久能被捡走」，真正的重新签发按票自己的到期时间走
  var TICKET_POLL_MS = 4000;
  // 签发失败后的退避：离线时轮询与页面的每次读取都不能变成对证明接口的轰炸（与桌面壳同款口径）
  var TICKET_RETRY_MS = 10000;
  // 服务端 selfCheckSchema 对每个 id 限长 64，超长的 id 会让整次请求被 422 掉
  var ID_MAX_LENGTH = 64;
  var DEFAULT_API_ORIGIN = "https://game.baka.website";

  // —— 接口基址 ——
  // 内嵌产物的相对路径会打到 Capacitor 自己的 https://localhost（壳内只发 assets），
  // 证明三件事必须显式打到线上接口。允许页面覆盖，但只接受 https，与桌面壳 config.rs 同口径：
  // 不给「把签名发到假站」留口子。
  function apiBase() {
    var override = "";
    try {
      override = String(window.__BAKA_API_BASE__ || "").replace(/\/+$/, "");
    } catch (e) {
      override = "";
    }
    return override.indexOf("https://") === 0 ? override : DEFAULT_API_ORIGIN;
  }

  function plugin() {
    var C = window.Capacitor;
    if (!C || typeof C.registerPlugin !== "function") {
      throw new Error("BAKA_CHANNEL_NATIVE_UNAVAILABLE");
    }
    return C.registerPlugin("BakaChannel");
  }

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* 隐私模式退化：下次重新注册 */
    }
  }

  // —— HTTP：只认 JSON，4xx 的可归因码挂在 err.code 上供重试判定 ——
  // 服务端错误信封是 { error: { code, message, traceId } }，兼容 error 直接给字符串码的写法。
  function errorCodeOf(payload) {
    var held = payload && payload.error;
    if (!held) return "";
    return typeof held === "string" ? held : String(held.code || "");
  }

  function postJson(path, body) {
    return fetch(apiBase() + path, {
      method: "POST",
      credentials: "include", // 复用壳内已登录的账号会话
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.text().then(function (text) {
        var payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch (e) {
          payload = null; // 网关兜底页之类非 JSON 错误体：只当作「没拿到码」，不掩盖状态码
        }
        if (!res.ok) {
          var code = errorCodeOf(payload) || "HTTP_" + res.status;
          var err = new Error("BAKA_CHANNEL_HTTP_" + res.status + ":" + code);
          err.code = code;
          throw err;
        }
        return payload || {};
      });
    });
  }

  function unwrap(payload, field) {
    // 服务端直接回字段；留一层 { data: ... } 容错，与注册响应既有口径一致
    if (!payload) return undefined;
    if (payload[field] !== undefined) return payload[field];
    if (payload.data && payload.data[field] !== undefined) return payload.data[field];
    return undefined;
  }

  // —— 自检：注册与每次 attest 都重报一遍，判定在服务端（本壳只如实上报 id）——
  function clampIds(list) {
    if (!list || !list.length) return [];
    var out = [];
    for (var index = 0; index < list.length; index++) {
      out.push(String(list[index]).slice(0, ID_MAX_LENGTH));
    }
    return out;
  }

  function levelOf(value) {
    return value === "trusted" || value === "degraded" || value === "rejected" ? value : "degraded";
  }

  function buildSelfCheck() {
    return plugin()
      .selfCheck({})
      .then(function (r) {
        return {
          hardFail: clampIds(r && r.hardFail),
          softFail: clampIds(r && r.softFail),
          attestationLevel: levelOf(r && r.attestationLevel),
        };
      });
  }

  // —— 注册：一次性上报公钥与平台证明，换 clientId（§3 的字段，服务端 schema 是 strict 的）——
  // 证明链只在这一步发：服务端验完链就把档位记进设备表，之后的握手只签挑战、不再收链。
  // 老 APK 的 getKeyInfo 给不出链时就不带这个字段，服务端按「没有平台证明」处理，不影响注册。
  var CHAIN_MAX = 8; // 与服务端 register 路由的 chain maxItems 一致
  function buildAttestation(info) {
    var chain = info && info.keyAttestationChain;
    var challenge = info && info.attestationChallenge;
    if (!chain || !chain.length || !challenge) return null;
    var pems = [];
    for (var index = 0; index < chain.length && index < CHAIN_MAX; index++) {
      pems.push(String(chain[index]));
    }
    return { attestationChallenge: String(challenge), chain: pems };
  }

  async function registerDevice() {
    var info = await plugin().getKeyInfo({}); // { publicKey, keyAlgorithm, attestationChallenge, keyAttestationChain, packageName, strongBox }
    var report = await buildSelfCheck();
    var body = {
      clientType: "mobile",
      platform: "android",
      clientVersion: CLIENT_VERSION,
      // 必须取自 §3 的词表：ec-p256（Android KeyStore），服务端按它选验签分支。
      // 老 APK 可能报 "ec-p256-sha256"，strict schema 会 422 掉整次注册，所以在这里归一化。
      keyAlgorithm: "ec-p256",
      publicKey: info && info.publicKey ? info.publicKey : "",
      selfCheck: report,
    };
    if (!body.publicKey) throw new Error("BAKA_CHANNEL_REGISTER_MISSING_PUBLIC_KEY");
    var attestation = buildAttestation(info);
    if (attestation) body.attestation = attestation;
    var json = await postJson(REGISTER_PATH, body);
    var issued = unwrap(json, "clientId");
    if (typeof issued !== "string" || !issued)
      throw new Error("BAKA_CHANNEL_REGISTER_MISSING_CLIENT_ID");
    storageSet(STORAGE_KEY, issued);
    return issued;
  }

  // 惰性注册：本地已有 clientId（localStorage）就直接用，第一次要票时才真的去注册。
  // 服务端回 CLIENT_UNKNOWN 时 force=true 补一次——注册按公钥派生 id，天然幂等。
  function ensureRegistered(force) {
    if (!force && clientId) return Promise.resolve(clientId);
    if (pending) return pending;
    pending = registerDevice().then(
      function (issued) {
        clientId = issued;
        pending = null;
        return issued;
      },
      function (e) {
        pending = null;
        throw e;
      }
    );
    return pending;
  }

  // —— 原生签名：只出 base64(DER ECDSA-P256-SHA256)，challenge 的字节原样进 Keystore ——
  function signWithKeystore(challenge) {
    return plugin()
      .sign({ challenge: challenge })
      .then(function (r) {
        if (!r || typeof r.signature !== "string") throw new Error("BAKA_CHANNEL_SIGN_EMPTY");
        return r.signature;
      });
  }

  // —— 一次完整证明：领挑战 → 签名 → 换票，结果留在本闭包里给 channelTicket 读 ——
  function attestOnce() {
    return ensureRegistered()
      .then(function (id) {
        return postJson(CHALLENGE_PATH, { clientId: id }).then(function (json) {
          var challenge = unwrap(json, "challenge");
          if (typeof challenge !== "string" || !challenge) {
            throw new Error("BAKA_CHANNEL_CHALLENGE_EMPTY");
          }
          return signWithKeystore(challenge).then(function (signature) {
            return buildSelfCheck().then(function (report) {
              return postJson(ATTEST_PATH, {
                clientId: id,
                challenge: challenge,
                signature: signature,
                clientType: "mobile",
                clientVersion: CLIENT_VERSION,
                selfCheck: report,
              }).then(function (attestJson) {
                var ticket = unwrap(attestJson, "ticket");
                if (typeof ticket !== "string" || !ticket) {
                  throw new Error("BAKA_CHANNEL_TICKET_EMPTY");
                }
                return { value: ticket, expiresAt: Number(unwrap(attestJson, "expiresAt")) || 0 };
              });
            });
          });
        });
      })
      .catch(function (e) {
        // 设备不认识这个 clientId（服务端换库/清理过）：忘掉本地缓存，下次强制重新注册
        if (e && e.code === "CLIENT_UNKNOWN") {
          clientId = "";
          storageSet(STORAGE_KEY, "");
        }
        throw e;
      });
  }

  var ticket = { value: "", expiresAt: 0 };
  var ticketBusy = false;
  var ticker = 0;
  var failureUntil = 0;

  function ticketIsUsable() {
    return ticket.value.length > 0 && ticket.expiresAt - Date.now() > TICKET_MARGIN_MS;
  }

  // force=false 用于定时轮询：手里那张还能用就不重跑一遍签发，免得白打接口
  function refreshTicket(force) {
    if (ticketBusy) return;
    if (!force && ticketIsUsable()) return;
    // 失败退避期内一律不去（含页面强制读取的那次）：签不出就是暂时签不出，
    // 让页面拿空串按 Web 口径连接，比每 4 秒撞一次墙好
    if (Date.now() < failureUntil) return;
    ticketBusy = true;
    startTicker(); // 页面第一次要票之后，签发循环才一直转下去（此前保持惰性）
    attestOnce().then(
      function (issued) {
        ticketBusy = false;
        failureUntil = 0;
        ticket = issued;
      },
      function () {
        // 签不出票（离线、未注册、自检判死、服务端未启用通道）：保持空串，页面按 Web 口径连接
        ticketBusy = false;
        failureUntil = Date.now() + TICKET_RETRY_MS;
        ticket = { value: "", expiresAt: 0 };
      }
    );
  }

  function startTicker() {
    if (ticker) return;
    ticker = setInterval(function () {
      refreshTicket(false);
    }, TICKET_POLL_MS);
  }

  window.__BAKA_CHANNEL__ = {
    clientType: "mobile",
    platform: "android",
    clientVersion: CLIENT_VERSION,
    sign: function (challenge) {
      if (typeof challenge !== "string" || challenge.length === 0) {
        return Promise.reject(new Error("BAKA_CHANNEL_BAD_CHALLENGE"));
      }
      return ensureRegistered().then(function () {
        return signWithKeystore(challenge);
      });
    },
    selfCheck: buildSelfCheck,
  };

  // 一次性票据：读一次就作废并立刻补签，第二次连接绝不会带上已被服务端消费掉的旧票。
  // 用访问器而不是普通字段，页面对它只有同步读取（`bakaChannelQuery()`）。
  Object.defineProperty(window.__BAKA_CHANNEL__, "channelTicket", {
    enumerable: true,
    configurable: false,
    get: function () {
      var handed = ticket.value;
      ticket = { value: "", expiresAt: 0 };
      refreshTicket(true);
      return handed;
    },
  });

  // 壳被切回前台时票多半已经过期（后台里定时器会被节流）：立刻补一张再等页面来读
  document.addEventListener(
    "visibilitychange",
    function () {
      if (ticker && document.visibilityState === "visible") refreshTicket(true);
    },
    false
  );
})();
