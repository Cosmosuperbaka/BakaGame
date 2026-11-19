import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CLIENT_TICKET_TTL_MS,
  ClientChannel,
  InMemoryClientChannelStore,
  SELF_CHECK_WEIGHTS,
} from "../src/infrastructure/ClientChannel";
import {
  CLIENT_ATTESTATION_CHAIN_MAX,
  CLIENT_CHANNEL_PATHS,
  CLIENT_SELF_CHECK_ID_MAX_LENGTH,
  CLIENT_TICKET_REFRESH_MARGIN_MS,
} from "../src/infrastructure/ClientChannelContract";
import { clientChannelRoutes } from "../src/transport/routes/ClientChannelRoutes";

/**
 * 壳与服务端的通道契约对账。
 *
 * 桌面（Rust）、移动（注入 JS 与 Kotlin）和服务端是三种运行时，没法共享类型，
 * 所以这里读各壳的**源码**，把里面写死的路径、字段名、词表与常量逐项和服务端的权威定义比：
 * 路径与余量等取自 `ClientChannelContract`，字段与枚举取自路由的请求体 schema，
 * 自检词表取自权重表。任何一边改了而另一边没改，这里就红。
 * 契约漂移的故障方向是失败关闭（整台设备换不到票），所以必须在合并前发现，而不是上线后靠用户反馈。
 */
const root = resolve(import.meta.dir, "../..");
const read = (relative: string) =>
  readFileSync(join(root, relative), "utf8").replaceAll("\r\n", "\n");

const rust = {
  device: read("Desktop/src-tauri/src/device.rs"),
  attest: read("Desktop/src-tauri/src/attest.rs"),
  selfcheck: read("Desktop/src-tauri/src/selfcheck.rs"),
  bridge: read("Desktop/src-tauri/src/bridge.rs"),
};
/** 桌面注入脚本原文（`bridge.rs` 里的原始字符串）：对账只读它，不读文件头的契约注释。 */
const desktopScript = (() => {
  const match = /const BRIDGE_JS: &str = r#"([\s\S]*?)"#;/.exec(rust.bridge);
  if (!match) throw new Error("没有在 bridge.rs 里找到桥接脚本原文");
  return match[1];
})();
const mobileBridge = read("Mobile/bridge/baka-bridge.js");
const selfCheckKt = read("Mobile/android/app/src/main/java/website/baka/game/channel/SelfCheck.kt");

// ——— 从源码取字面量 ———

const rustString = (source: string, name: string): string => {
  const match = new RegExp(`const ${name}: &str = "([^"]*)";`).exec(source);
  if (!match) throw new Error(`Rust 源码里没有字符串常量 ${name}`);
  return match[1];
};
const rustNumber = (source: string, name: string): number => {
  const match = new RegExp(`const ${name}: u64 = ([\\d_]+);`).exec(source);
  if (!match) throw new Error(`Rust 源码里没有数值常量 ${name}`);
  return Number(match[1].replaceAll("_", ""));
};
const camel = (snake: string) =>
  snake.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
/** 结构体字段名按 serde 的 camelCase 改写后的集合（这些结构体都是 `rename_all = "camelCase"`）。 */
const rustFields = (source: string, struct: string): string[] => {
  const start = new RegExp(`struct ${struct}(<[^>]*>)? \\{`).exec(source);
  if (!start) throw new Error(`Rust 源码里没有结构体 ${struct}`);
  const body = source.slice(start.index + start[0].length, source.indexOf("\n}", start.index));
  return [...body.matchAll(/^\s*(?:pub\s+)?([a-z][a-z0-9_]*):\s/gm)].map((match) =>
    camel(match[1])
  );
};
const jsString = (source: string, name: string): string => {
  const match = new RegExp(`var ${name} = "([^"]*)";`).exec(source);
  if (!match) throw new Error(`JS 源码里没有字符串变量 ${name}`);
  return match[1];
};
const jsNumber = (source: string, name: string): number => {
  const match = new RegExp(`var ${name} = ([\\d_]+);`).exec(source);
  if (!match) throw new Error(`JS 源码里没有数值变量 ${name}`);
  return Number(match[1]);
};
/**
 * 从锚点匹配文本里的第一个 `{` 起做括号匹配，取这一层对象字面量的正文：
 * 行注释剥掉（注释里可能写着同名的示例值），嵌套层剥掉，只留最外层。
 */
const jsObjectBody = (source: string, anchor: RegExp): string => {
  const found = anchor.exec(source);
  if (!found) throw new Error(`JS 源码里没有锚点 ${anchor}`);
  const open = found.index + found[0].indexOf("{");
  let depth = 0;
  let end = open;
  for (; end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    if (source[end] === "}") depth -= 1;
    if (depth === 0) break;
  }
  let flat = source.slice(open + 1, end).replace(/(^|[^:"])\/\/[^\n]*/g, "$1");
  for (;;) {
    const next = flat.replace(/\{[^{}]*\}/g, "");
    if (next === flat) break;
    flat = next;
  }
  return flat;
};
/** 对象字面量最外层的键；先抹掉字符串，免得字符串里的冒号被当成键。 */
const jsObjectKeys = (source: string, anchor: RegExp): string[] =>
  [
    ...jsObjectBody(source, anchor)
      .replace(/"[^"\n]*"/g, '""')
      .matchAll(/(?:^|[,\s])([A-Za-z]\w*)\s*:/g),
  ].map((match) => match[1]);
/** 对象字面量最外层某个键的字符串值：取的是代码里的值，不会命中注释。 */
const jsObjectValue = (source: string, anchor: RegExp, key: string): string => {
  const match = new RegExp(`(?:^|[,\\s])${key}\\s*:\\s*"([^"]*)"`).exec(
    jsObjectBody(source, anchor)
  );
  if (!match) throw new Error(`锚点 ${anchor} 的对象里没有字符串键 ${key}`);
  return match[1];
};
/** 两个标记之间的源码片段（按调用点拆开取值用）。 */
const between = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`JS 源码里找不到片段 ${from} … ${to}`);
  return source.slice(start, end);
};
/** 片段里 `unwrap(来源变量, "字段")` 的全部调用。 */
const unwrapCalls = (fragment: string): Array<{ source: string; field: string }> =>
  [...fragment.matchAll(/unwrap\(\s*(\w+),\s*"(\w+)"\s*\)/g)].map((match) => ({
    source: match[1],
    field: match[2],
  }));

// ——— 服务端权威：路由的请求体与查询 schema ———

type Schema = {
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
  const?: string;
  maxLength?: number;
  maxItems?: number;
};
const routes = clientChannelRoutes(undefined).routes;
const schemaOf = (method: "POST" | "GET", path: string, kind: "body" | "query"): Schema => {
  const route = routes.find((entry) => entry.method === method && entry.path === path);
  const schema = (route?.hooks as Record<string, Schema> | undefined)?.[kind];
  if (!schema?.properties) throw new Error(`路由 ${method} ${path} 没有 ${kind} schema`);
  return schema;
};
const keysOf = (schema: Schema) => Object.keys(schema.properties ?? {}).sort();
const enumOf = (schema: Schema): string[] => (schema.anyOf ?? []).map((entry) => entry.const ?? "");
const sorted = (values: string[]) => [...values].sort();

/** 壳发出的字段必须都在 strict schema 里，且必填项一个不少。 */
function expectMatchesSchema(shell: string[], schema: Schema, label: string) {
  const allowed = new Set(Object.keys(schema.properties ?? {}));
  const extra = shell.filter((key) => !allowed.has(key));
  expect(extra, `${label} 多发了服务端 schema 不认的字段`).toEqual([]);
  const missing = (schema.required ?? []).filter((key) => !shell.includes(key));
  expect(missing, `${label} 缺了服务端必填字段`).toEqual([]);
}

const registerBody = schemaOf("POST", CLIENT_CHANNEL_PATHS.register, "body");
const attestBody = schemaOf("POST", CLIENT_CHANNEL_PATHS.attest, "body");
const challengeBody = schemaOf("POST", CLIENT_CHANNEL_PATHS.challenge, "body");
const selfCheckSchema = registerBody.properties?.selfCheck as Schema;
const attestationSchema = registerBody.properties?.attestation as Schema;
const clientTypes = enumOf(registerBody.properties?.clientType as Schema);
const keyAlgorithms = enumOf(registerBody.properties?.keyAlgorithm as Schema);

describe("路径", () => {
  test("权威契约里的路径就是服务端实际挂载的路由", () => {
    expect(sorted(routes.map((route) => route.path))).toEqual(
      sorted(Object.values(CLIENT_CHANNEL_PATHS))
    );
  });
  test("桌面壳的三个请求路径与契约相等", () => {
    expect(rustString(rust.device, "REGISTER_PATH")).toBe(CLIENT_CHANNEL_PATHS.register);
    expect(rustString(rust.attest, "CHALLENGE_PATH")).toBe(CLIENT_CHANNEL_PATHS.challenge);
    expect(rustString(rust.attest, "ATTEST_PATH")).toBe(CLIENT_CHANNEL_PATHS.attest);
  });
  test("移动壳桥脚本的四个请求路径与契约相等", () => {
    expect(jsString(mobileBridge, "REGISTER_PATH")).toBe(CLIENT_CHANNEL_PATHS.register);
    expect(jsString(mobileBridge, "CHALLENGE_PATH")).toBe(CLIENT_CHANNEL_PATHS.challenge);
    expect(jsString(mobileBridge, "ATTEST_PATH")).toBe(CLIENT_CHANNEL_PATHS.attest);
    expect(jsString(mobileBridge, "HOT_UPDATE_PATH")).toBe(CLIENT_CHANNEL_PATHS.webBundle);
  });
  test("前端用到的通道接口路径都在契约里", () => {
    const found = new Set<string>();
    const walk = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const full = join(directory, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name))
          for (const match of readFileSync(full, "utf8").matchAll(/\/api\/client\/[a-z-]+/g))
            found.add(match[0]);
      }
    };
    walk(join(root, "Client/src"));
    expect(found.size).toBeGreaterThan(0);
    const known = new Set<string>(Object.values(CLIENT_CHANNEL_PATHS));
    expect([...found].filter((path) => !known.has(path))).toEqual([]);
  });
});

describe("请求字段", () => {
  test("桌面壳：注册、领挑战、换票的请求体字段与服务端 strict schema 对得上", () => {
    expectMatchesSchema(rustFields(rust.device, "RegisterRequest"), registerBody, "桌面注册");
    expectMatchesSchema(rustFields(rust.attest, "ChallengeRequest"), challengeBody, "桌面领挑战");
    expectMatchesSchema(rustFields(rust.attest, "AttestRequest"), attestBody, "桌面换票");
  });
  test("移动壳：注册、领挑战、换票的请求体字段与服务端 strict schema 对得上", () => {
    const register = jsObjectKeys(mobileBridge, /var body = \{/);
    // 证明链只在能取到时才挂到注册体上
    if (/body\.attestation = /.test(mobileBridge)) register.push("attestation");
    expectMatchesSchema(register, registerBody, "移动注册");
    expectMatchesSchema(
      jsObjectKeys(mobileBridge, /postJson\(CHALLENGE_PATH, \{/),
      challengeBody,
      "移动领挑战"
    );
    expectMatchesSchema(
      jsObjectKeys(mobileBridge, /postJson\(ATTEST_PATH, \{/),
      attestBody,
      "移动换票"
    );
  });
  test("自检报告字段：两个壳各带自己那几项，都在 schema 里，必填的两项不缺", () => {
    expectMatchesSchema(
      rustFields(rust.selfcheck, "SelfCheckReport"),
      selfCheckSchema,
      "桌面自检报告"
    );
    expectMatchesSchema(
      jsObjectKeys(mobileBridge, /return \{\n\s+hardFail:/),
      selfCheckSchema,
      "移动自检报告"
    );
  });
  test("移动壳上报的证明材料字段与 schema 一致，张数上限与服务端相等", () => {
    expect(sorted(jsObjectKeys(mobileBridge, /return \{ attestationChallenge:/))).toEqual(
      keysOf(attestationSchema)
    );
    expect(jsNumber(mobileBridge, "CHAIN_MAX")).toBe(CLIENT_ATTESTATION_CHAIN_MAX);
    const chain = attestationSchema.properties?.chain as Schema;
    expect(chain.maxItems).toBe(CLIENT_ATTESTATION_CHAIN_MAX);
  });
  test("移动壳资源包查询的参数名与服务端查询 schema 一致", () => {
    const query = schemaOf("GET", CLIENT_CHANNEL_PATHS.webBundle, "query");
    const sent = [...mobileBridge.matchAll(/[?&](\w+)=/g)].map((match) => match[1]);
    expect(sorted(sent)).toEqual(sorted(query.required ?? keysOf(query)));
  });
});

describe("取值与词表", () => {
  test("客户端类型、平台与密钥算法：壳写的值都在服务端枚举与长度限制内", () => {
    const desktopType = rustString(rust.device, "CLIENT_TYPE");
    expect(clientTypes).toContain(desktopType);
    // 移动壳的身份写在三处代码里：注册体、换票体、页面可见对象，三处必须一致且在枚举内
    const mobileRegister = /var body = \{/;
    const mobileAttest = /postJson\(ATTEST_PATH, \{/;
    // 行首锚定：文件头注释里也有一份同样的示例，不能命中它
    const mobileVisible = /^ {2}window\.__BAKA_CHANNEL__ = \{/m;
    const mobileTypes = [mobileRegister, mobileAttest, mobileVisible].map((anchor) =>
      jsObjectValue(mobileBridge, anchor, "clientType")
    );
    expect(new Set(mobileTypes).size).toBe(1);
    expect(clientTypes).toContain(mobileTypes[0]);
    const mobilePlatforms = [mobileRegister, mobileVisible].map((anchor) =>
      jsObjectValue(mobileBridge, anchor, "platform")
    );
    expect(new Set(mobilePlatforms).size).toBe(1);
    expect(keyAlgorithms).toContain(rustString(rust.device, "KEY_ALGORITHM"));
    expect(keyAlgorithms).toContain(jsObjectValue(mobileBridge, mobileRegister, "keyAlgorithm"));
    const platformLimit = (registerBody.properties?.platform as Schema).maxLength ?? 0;
    for (const platform of [rustString(rust.device, "PLATFORM"), mobilePlatforms[0]]) {
      expect(platform.length).toBeGreaterThan(0);
      expect(platform.length).toBeLessThanOrEqual(platformLimit);
    }
    // 桌面注入脚本对页面声明的身份与注册时上报的是同一个值（取脚本里 channel 对象的代码取值）
    const desktopChannel = /var channel = \{/;
    expect(jsObjectValue(desktopScript, desktopChannel, "clientType")).toBe(desktopType);
    expect(jsObjectValue(desktopScript, desktopChannel, "platform")).toBe(
      rustString(rust.device, "PLATFORM")
    );
  });
  test("移动壳认的证明档位词表与服务端一致", () => {
    const levels = enumOf(selfCheckSchema.properties?.attestationLevel as Schema);
    const written =
      /return value === "trusted" \|\| value === "degraded" \|\| value === "rejected"/;
    expect(written.test(mobileBridge)).toBe(true);
    expect(sorted(levels)).toEqual(["degraded", "rejected", "trusted"]);
  });
  test("自检 id 长度上限：壳截断的长度不超过服务端 schema 的限制", () => {
    for (const key of ["hardFail", "softFail"]) {
      const item = (selfCheckSchema.properties?.[key] as Schema & { items?: Schema }).items;
      expect(item?.maxLength).toBe(CLIENT_SELF_CHECK_ID_MAX_LENGTH);
    }
    expect(jsNumber(mobileBridge, "ID_MAX_LENGTH")).toBe(CLIENT_SELF_CHECK_ID_MAX_LENGTH);
  });

  /** 壳里每个自检 id 与它放进的格子（硬/软）。`platform_unsupported` 是「标可疑」项，放哪格都不计分。 */
  const desktopIds = (() => {
    const names = new Map(
      [...rust.selfcheck.matchAll(/pub const (CHECK_\w+): &str = "(\w+)";/g)].map((match) => [
        match[1],
        match[2],
      ])
    );
    const placed = [
      ...rust.selfcheck.matchAll(/report\.(hard_fail|soft_fail)\.push\((CHECK_\w+)\.into\(\)\)/g),
    ].map((match) => ({
      id: names.get(match[2]) ?? "",
      cell: match[1] === "hard_fail" ? "hard" : "soft",
    }));
    return { all: [...names.values()], placed };
  })();
  const mobileIds = [...selfCheckKt.matchAll(/\b(hard|soft)\.add\("([a-z0-9_]+)/g)].map(
    (match) => ({
      id: match[2],
      cell: match[1],
    })
  );

  test("桌面壳上报的 id 全部在服务端权重表里", () => {
    expect(desktopIds.all.length).toBeGreaterThan(0);
    expect(desktopIds.all.filter((id) => SELF_CHECK_WEIGHTS[id] === undefined)).toEqual([]);
    for (const id of desktopIds.all)
      expect(id.length).toBeLessThanOrEqual(CLIENT_SELF_CHECK_ID_MAX_LENGTH);
  });
  test("移动壳上报的 id 前缀全部在服务端权重表里", () => {
    expect(mobileIds.length).toBeGreaterThan(0);
    expect(mobileIds.filter(({ id }) => SELF_CHECK_WEIGHTS[id] === undefined)).toEqual([]);
  });
  test("权重表里没有任何壳都不会上报的死条目", () => {
    const emitted = new Set([...desktopIds.all, ...mobileIds.map(({ id }) => id)]);
    expect(Object.keys(SELF_CHECK_WEIGHTS).filter((id) => !emitted.has(id))).toEqual([]);
  });
  test("壳把 id 放进的格子与服务端权重一致：硬失败不进软格，软失败不进硬格", () => {
    const mismatched = [...desktopIds.placed, ...mobileIds].filter(({ id, cell }) => {
      const weight = SELF_CHECK_WEIGHTS[id];
      return weight !== "mark" && weight !== cell;
    });
    expect(mismatched).toEqual([]);
  });
});

describe("票据时间常量", () => {
  const poll = [desktopScript, mobileBridge].map((source) => jsNumber(source, "TICKET_POLL_MS"));
  const margins = {
    desktopRust: rustNumber(rust.attest, "TICKET_MARGIN_MS"),
    desktopScript: jsNumber(desktopScript, "TICKET_MARGIN_MS"),
    mobileScript: jsNumber(mobileBridge, "TICKET_MARGIN_MS"),
  };
  test("三处提前作废的余量都等于权威契约值", () => {
    expect(margins).toEqual({
      desktopRust: CLIENT_TICKET_REFRESH_MARGIN_MS,
      desktopScript: CLIENT_TICKET_REFRESH_MARGIN_MS,
      mobileScript: CLIENT_TICKET_REFRESH_MARGIN_MS,
    });
  });
  test("轮询间隔加余量必须小于票的有效期，否则壳补票总是慢一拍", () => {
    for (const interval of poll)
      expect(interval + CLIENT_TICKET_REFRESH_MARGIN_MS).toBeLessThan(CLIENT_TICKET_TTL_MS);
  });
  test("壳对服务端给的有效期做的封顶不得低于真实有效期，两个壳取值相同", () => {
    const desktopCap =
      Number(
        /TICKET_TTL_SANITY_CAP: Duration = Duration::from_secs\((\d+)\)/.exec(rust.attest)?.[1]
      ) * 1000;
    const mobileCap = jsNumber(mobileBridge, "TICKET_TTL_SANITY_CAP_MS");
    expect(desktopCap).toBe(mobileCap);
    expect(desktopCap).toBeGreaterThanOrEqual(CLIENT_TICKET_TTL_MS);
  });
});

describe("响应字段", () => {
  /** 按壳的请求形状走一遍真实路由，取回三个接口响应里实际存在的字段。 */
  async function serverResponses() {
    const app = clientChannelRoutes(
      new ClientChannel({
        store: new InMemoryClientChannelStore(),
        minimumVersion: () => "",
      })
    );
    const post = async (path: string, body: unknown) => {
      const response = await app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": "203.0.113.50" },
          body: JSON.stringify(body),
        })
      );
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const selfCheck = { hardFail: [], softFail: [], keyProtection: "software" };
    const register = await post(CLIENT_CHANNEL_PATHS.register, {
      clientType: "desktop",
      platform: "windows",
      clientVersion: "0.1.2",
      keyAlgorithm: "ed25519",
      publicKey: raw,
      selfCheck,
    });
    const clientId = register.clientId as string;
    const challenge = await post(CLIENT_CHANNEL_PATHS.challenge, { clientId });
    const attest = await post(CLIENT_CHANNEL_PATHS.attest, {
      clientId,
      challenge: challenge.challenge,
      signature: nodeSign(
        null,
        Buffer.from(challenge.challenge as string, "ascii"),
        privateKey
      ).toString("base64"),
      clientType: "desktop",
      clientVersion: "0.1.2",
      selfCheck,
    });
    return { register, challenge, attest };
  }

  test("桌面壳读取的响应字段服务端都给", async () => {
    const { register, challenge, attest } = await serverResponses();
    const has = (response: Record<string, unknown>) => (name: string) => name in response;
    expect(rustFields(rust.device, "RegisterResponse").filter((n) => !has(register)(n))).toEqual(
      []
    );
    expect(rustFields(rust.attest, "ChallengeResponse").filter((n) => !has(challenge)(n))).toEqual(
      []
    );
    expect(rustFields(rust.attest, "AttestResponse").filter((n) => !has(attest)(n))).toEqual([]);
  });
  test("桌面壳交给页面的票据载荷：Rust 结构体的字段与注入脚本读取的字段一致", () => {
    const read = between(desktopScript, 'invoke("baka_ticket"', "}, function () {");
    const scriptReads = [...read.matchAll(/\bvalue\.(\w+)/g)].map((match) => match[1]);
    expect(sorted([...new Set(scriptReads)])).toEqual(
      sorted(rustFields(rust.attest, "TicketPayload"))
    );
  });
  test("移动壳按名字读取的响应字段服务端都给", async () => {
    const { register, challenge, attest } = await serverResponses();
    // 按调用点拆开：注册响应、领挑战响应、换票响应各读各的，不能拿别家响应里的字段凑数
    const registerReads = unwrapCalls(
      between(mobileBridge, "async function registerDevice", "function ensureRegistered")
    );
    const challengeReads = unwrapCalls(
      between(mobileBridge, "postJson(CHALLENGE_PATH", "signWithKeystore(challenge)")
    );
    const attestReads = unwrapCalls(mobileBridge).filter(({ source }) => source === "attestJson");
    for (const [label, reads, response] of [
      ["注册", registerReads, register],
      ["领挑战", challengeReads, challenge],
      ["换票", attestReads, attest],
    ] as const) {
      expect(reads.length, `${label}：没有读到任何响应字段`).toBeGreaterThan(0);
      expect(
        reads.filter(({ field }) => !(field in response)).map(({ field }) => field),
        `移动壳${label}响应里读了服务端没给的字段`
      ).toEqual([]);
    }
    // 拆开的片段要覆盖桥脚本里全部按名字读取的调用，不能有漏网的
    expect(registerReads.length + challengeReads.length + attestReads.length).toBe(
      unwrapCalls(mobileBridge).length
    );
  });
});
