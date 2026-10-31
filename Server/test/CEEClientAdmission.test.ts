import { describe, expect, test } from "bun:test";
import { requireCEEClientAdmission } from "../src/application/CEEClientAdmission";
import { AppError } from "../src/domain/Errors";
import type { ClientChannelProof, ConnectionRecord } from "../src/shared/Index";

const channel = (patch: Partial<ClientChannelProof> = {}): ClientChannelProof => ({
  clientId: "client-1",
  clientType: "desktop",
  clientVersion: "1.2.3",
  keyProtection: "hardware",
  ...patch,
});

const account = { userId: "u1", image: null };

/** 只填准入真正读的那几个字段，其余按最小形状构造。 */
const record = (fields: {
  clientChannel?: ClientChannelProof;
  account?: ConnectionRecord["account"];
  isAgent?: boolean;
}): ConnectionRecord => ({
  id: "c1",
  lobbySubscribed: false,
  send: () => {},
  close: () => {},
  ...fields,
});

const codeOf = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error.code : `非 AppError：${String(error)}`;
  }
  return "未抛错";
};

const messageOf = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error.message;
    throw error;
  }
  throw new Error("预期抛出 AppError，但调用成功了");
};

describe("排位准入", () => {
  test("网页连接（没有通道证明）被拒", () => {
    expect(codeOf(() => requireCEEClientAdmission(record({ account }), "ranked"))).toBe(
      "CLIENT_REQUIRED"
    );
    expect(messageOf(() => requireCEEClientAdmission(record({ account }), "ranked"))).toBe(
      "排位赛需要使用 BakaGame 客户端"
    );
  });

  test("客户端版本过低被拒", () => {
    const connection = record({ clientChannel: channel({ outdated: true }), account });
    expect(codeOf(() => requireCEEClientAdmission(connection, "ranked"))).toBe("CLIENT_OUTDATED");
    expect(messageOf(() => requireCEEClientAdmission(connection, "ranked"))).toBe(
      "客户端版本过低，请更新后再进行排位"
    );
  });

  test("未登录被拒", () => {
    const connection = record({ clientChannel: channel() });
    expect(codeOf(() => requireCEEClientAdmission(connection, "ranked"))).toBe("LOGIN_REQUIRED");
    expect(messageOf(() => requireCEEClientAdmission(connection, "ranked"))).toBe(
      "排位赛需要先登录"
    );
  });

  test("Agent 连接被拒，即使带通道证明与账号", () => {
    const connection = record({ clientChannel: channel(), account, isAgent: true });
    expect(codeOf(() => requireCEEClientAdmission(connection, "ranked"))).toBe(
      "AGENTS_NOT_ALLOWED"
    );
    expect(messageOf(() => requireCEEClientAdmission(connection, "ranked"))).toBe(
      "排位赛不允许 Agent 接入"
    );
  });

  test("Agent 判断排在最前：过期客户端的 Agent 也先回 Agent 错误", () => {
    const connection = record({
      clientChannel: channel({ outdated: true }),
      account,
      isAgent: true,
    });
    expect(codeOf(() => requireCEEClientAdmission(connection, "ranked"))).toBe(
      "AGENTS_NOT_ALLOWED"
    );
  });

  test("客户端 + 已登录 + 非 Agent 放行", () => {
    expect(() =>
      requireCEEClientAdmission(record({ clientChannel: channel(), account }), "ranked")
    ).not.toThrow();
  });

  test("通道自检可疑不拦排位：只有过期与缺通道才是硬条件", () => {
    const connection = record({
      clientChannel: channel({ integrity: "suspect" }),
      account,
    });
    expect(() => requireCEEClientAdmission(connection, "ranked")).not.toThrow();
  });
});

describe("反作弊房准入（行为与文案不变）", () => {
  test("三条判断的顺序、错误码与文案原样保留", () => {
    expect(codeOf(() => requireCEEClientAdmission(record({ account }), "antiCheatRoom"))).toBe(
      "CLIENT_REQUIRED"
    );
    expect(messageOf(() => requireCEEClientAdmission(record({ account }), "antiCheatRoom"))).toBe(
      "当前连接没有客户端通道证明，请使用客户端重新进入游戏"
    );

    const outdated = record({ clientChannel: channel({ outdated: true }), account });
    expect(codeOf(() => requireCEEClientAdmission(outdated, "antiCheatRoom"))).toBe(
      "CLIENT_OUTDATED"
    );
    expect(messageOf(() => requireCEEClientAdmission(outdated, "antiCheatRoom"))).toBe(
      "客户端版本过低，请更新后再创建该房间"
    );

    const loggedOut = record({ clientChannel: channel() });
    expect(codeOf(() => requireCEEClientAdmission(loggedOut, "antiCheatRoom"))).toBe(
      "LOGIN_REQUIRED"
    );
    expect(messageOf(() => requireCEEClientAdmission(loggedOut, "antiCheatRoom"))).toBe(
      "创建反作弊房间要求已登录"
    );
  });

  test("反作弊房不拒绝 Agent 连接：Agent 那条只属于排位", () => {
    const connection = record({ clientChannel: channel(), account, isAgent: true });
    expect(() => requireCEEClientAdmission(connection, "antiCheatRoom")).not.toThrow();
  });
});
