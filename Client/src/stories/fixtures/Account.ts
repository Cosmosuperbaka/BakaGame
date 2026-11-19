import type { AccountProfile } from "@bakagame/shared";
import { AUTH_BASE_PATH } from "@bakagame/shared/values";
import { useAccountStore } from "@/stores/UseAccountStore";

// ==================== 账号、反馈与管理后台故事的假接口 ====================
// 只供 Storybook 与截图使用。oRPC 走 `/api/rpc/<路径>`，返回体是 `{ json, meta }`；
// Better Auth 端点走 `/api/auth/...`，返回体就是 JSON 本身。

/** 一个接口的答复：固定值、按请求体算出的值、一直不回，或网络失败。 */
export type StubReply = unknown | "pending" | "error" | ((input: unknown) => unknown);

const PENDING = "pending";
const ERROR = "error";

async function readInput(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const body = input instanceof Request ? await input.clone().text() : init?.body;
  if (typeof body !== "string" || !body) return undefined;
  try {
    const parsed = JSON.parse(body) as { json?: unknown };
    return parsed && typeof parsed === "object" && "json" in parsed ? parsed.json : parsed;
  } catch {
    return undefined;
  }
}

/**
 * 桩住一批接口。键是 oRPC 路径（如 `account/qqName`、`admin/users/list`）或以 `auth:` 开头的
 * Better Auth 路径（如 `auth:/passkey/list-user-passkeys`）。未列出的请求照常放行。返回还原函数。
 */
export function stubApi(routes: Record<string, StubReply>): () => void {
  const original = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const { pathname } = new URL(url, window.location.href);
    let key: string | undefined;
    let rpc = false;
    if (pathname.startsWith("/api/rpc/")) {
      key = pathname.slice("/api/rpc/".length);
      rpc = true;
    } else if (pathname.startsWith(AUTH_BASE_PATH)) {
      key = `auth:${pathname.slice(AUTH_BASE_PATH.length)}`;
    }
    if (key === undefined || !(key in routes)) return original(input, init);
    const reply = routes[key];
    if (reply === PENDING) return new Promise<Response>(() => {});
    if (reply === ERROR) throw new TypeError("Failed to fetch");
    const value =
      typeof reply === "function"
        ? (reply as (body: unknown) => unknown)(await readInput(input, init))
        : reply;
    return new Response(JSON.stringify(rpc ? { json: value ?? null, meta: [] } : value), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    window.fetch = original;
  };
}

export const STORY_PROFILE: AccountProfile = {
  id: "u-story",
  name: "小布丁",
  qqNumber: "123456789",
  image: null,
  showQq: false,
  role: "user",
  badges: [{ kind: "pioneer", serial: 42 }],
  equippedBadge: "pioneer",
  createdAt: "2026-09-01T08:00:00.000Z",
};

/** 预置账号状态；Store 是模块单例，故事结束时回到读取中。 */
export function presetAccount(
  patch: Partial<
    Pick<ReturnType<typeof useAccountStore.getState>, "status" | "profile" | "unreadFeedback">
  >
): () => void {
  useAccountStore.setState({ status: "guest", profile: null, unreadFeedback: 0, ...patch });
  return () => useAccountStore.setState({ status: "loading", profile: null, unreadFeedback: 0 });
}
