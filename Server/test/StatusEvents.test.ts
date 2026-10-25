import { describe, expect, test } from "bun:test";
import type {
  StatusEventFilter,
  StatusEventInput,
  StatusEventPatch,
  StatusEventRepository,
} from "../src/infrastructure/db/StatusEventRepository";
import type { PublicStatusEvent } from "../src/shared/Status";
import { createAccountTestApp } from "./AccountFixtures";

const ADMIN_QQ = "90001";

/** 事件仓储的内存替身：环境过滤在行上自记，行为与 SQL 版一致。 */
class MemoryStatusEventRepository implements StatusEventRepository {
  readonly rows = new Map<number, PublicStatusEvent & { environment: string }>();
  private nextId = 1;
  now = () => Date.now();

  async list(environment: string, filter: StatusEventFilter) {
    const items = [...this.rows.values()]
      .filter((event) => event.environment === environment)
      .filter((event) => (filter.kind ? event.kind === filter.kind : true))
      .filter((event) =>
        filter.active !== undefined
          ? (event.resolvedAt === null && event.status !== "done") === filter.active
          : true
      )
      .filter((event) => (filter.since !== undefined ? event.startedAt >= filter.since : true))
      .sort((left, right) => right.startedAt - left.startedAt);
    return {
      items: items.slice(filter.offset, filter.offset + filter.limit),
      total: items.length,
    };
  }

  async get(environment: string, id: number) {
    const row = this.rows.get(id);
    return row && row.environment === environment ? row : null;
  }

  async create(environment: string, input: StatusEventInput) {
    const id = this.nextId++;
    const event = {
      ...input,
      environment,
      id,
      updatedAt: this.now(),
    } as PublicStatusEvent & { environment: string };
    this.rows.set(id, event);
    return event;
  }

  async update(environment: string, id: number, patch: StatusEventPatch) {
    const row = await this.get(environment, id);
    if (!row) throw new Error("not found");
    const next = { ...row, ...patch, updatedAt: this.now() };
    this.rows.set(id, next);
    return next;
  }

  async remove(environment: string, id: number) {
    const row = await this.get(environment, id);
    if (row) this.rows.delete(id);
  }
}

const setup = async () => {
  const events = new MemoryStatusEventRepository();
  let clock = Date.parse("2026-10-25T12:00:00Z");
  const ctx = createAccountTestApp({
    adminQqNumbers: [ADMIN_QQ],
    statusEvents: events,
    now: () => clock,
  });
  events.now = () => clock;
  const admin = await ctx.signIn(ADMIN_QQ, "管理员");
  const alice = await ctx.signIn("10001", "Alice");
  return {
    ...ctx,
    clock: () => clock,
    tick: (ms: number) => {
      clock += ms;
    },
    events,
    adminCookie: admin.cookie,
    aliceCookie: alice.cookie,
  };
};

describe("状态事件管理", () => {
  test("游客 401、普通用户 403，管理员可发布事件", async () => {
    const { rpc, adminCookie, aliceCookie } = await setup();
    expect((await rpc("admin/statusEvents/list", {})).status).toBe(401);
    expect((await rpc("admin/statusEvents/list", {}, aliceCookie)).status).toBe(403);

    const created = await rpc(
      "admin/statusEvents/create",
      {
        kind: "incident",
        title: "搜索索引不可用",
        body: "Meilisearch 重启中，搜索暂时降级。",
        components: ["search"],
        startedAt: Date.parse("2026-10-25T11:30:00Z"),
        plannedEndAt: null,
      },
      adminCookie
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      kind: "incident",
      status: "investigating",
      resolvedAt: null,
    });
    expect((await rpc("admin/statusEvents/list", { active: true }, adminCookie)).body.total).toBe(1);
  });

  test("维护窗口必须有晚于开始时刻的结束时间，事件不能带计划结束", async () => {
    const { rpc, adminCookie } = await setup();
    const missingEnd = await rpc(
      "admin/statusEvents/create",
      {
        kind: "maintenance",
        title: "数据库维护",
        body: "迁移到新实例。",
        components: [],
        startedAt: Date.parse("2026-10-26T18:00:00Z"),
        plannedEndAt: null,
      },
      adminCookie
    );
    expect(missingEnd.status).toBe(400);

    const badEnd = await rpc(
      "admin/statusEvents/create",
      {
        kind: "maintenance",
        title: "数据库维护",
        body: "迁移到新实例。",
        components: [],
        startedAt: Date.parse("2026-10-26T18:00:00Z"),
        plannedEndAt: Date.parse("2026-10-26T17:00:00Z"),
      },
      adminCookie
    );
    expect(badEnd.status).toBe(400);

    const ok = await rpc(
      "admin/statusEvents/create",
      {
        kind: "maintenance",
        title: "数据库维护",
        body: "迁移到新实例。",
        components: ["backend"],
        startedAt: Date.parse("2026-10-26T18:00:00Z"),
        plannedEndAt: Date.parse("2026-10-26T20:00:00Z"),
      },
      adminCookie
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ kind: "maintenance", status: "scheduled" });
  });

  test("改状态推进进度：解决补上时刻，重开清空；类型档位不互通", async () => {
    const { rpc, adminCookie, tick, clock } = await setup();
    const created = (
      await rpc(
        "admin/statusEvents/create",
        {
          kind: "incident",
          title: "上游超时",
          body: "QQ 音乐接口超时。",
          components: ["qqmusic"],
          startedAt: Date.parse("2026-10-25T11:00:00Z"),
          plannedEndAt: null,
        },
        adminCookie
      )
    ).body as unknown as PublicStatusEvent;

    tick(600_000);
    const resolved = await rpc(
      "admin/statusEvents/update",
      { id: created.id, status: "resolved" },
      adminCookie
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolvedAt).toBe(clock());

    const reopened = await rpc(
      "admin/statusEvents/update",
      { id: created.id, status: "monitoring" },
      adminCookie
    );
    expect(reopened.body.resolvedAt).toBeNull();

    // 事件不能改成维护档的进度；维护也不能改成事件档。
    const wrongLane = await rpc(
      "admin/statusEvents/update",
      { id: created.id, status: "done" },
      adminCookie
    );
    expect(wrongLane.status).toBe(400);

    expect((await rpc("admin/statusEvents/remove", { id: created.id }, adminCookie)).status).toBe(
      200
    );
    expect((await rpc("admin/statusEvents/remove", { id: created.id }, adminCookie)).status).toBe(
      404
    );
  });

  test("每次写操作先留审计", async () => {
    const { rpc, adminCookie, audit } = await setup();
    await rpc(
      "admin/statusEvents/create",
      {
        kind: "incident",
        title: "图床抖动",
        body: "边缘节点回源异常。",
        components: ["images"],
        startedAt: Date.parse("2026-10-25T11:00:00Z"),
        plannedEndAt: null,
      },
      adminCookie
    );
    const actions = audit.entries
      .filter((entry) => entry.targetType === "statusEvent")
      .map((entry) => entry.action);
    expect(actions).toEqual(["statusEvent.create"]);
  });
});
