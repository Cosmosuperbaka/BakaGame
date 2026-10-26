import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";

import { AppError } from "../../domain/Errors";
import {
  PUBLIC_STATUS_COMPONENT_IDS,
  isPublicStatusEventStatus,
  type PublicStatusComponentId,
  type PublicStatusEvent,
  type PublicStatusEventStatus,
  type PublicStatusIncidentKind,
} from "../../shared/Status";
import type { Database } from "./Database";
import { statusEvent } from "./Schema";

/** 新建或改写一条事件时提交的字段；时间为 UTC 毫秒。 */
export interface StatusEventInput {
  kind: PublicStatusIncidentKind;
  title: string;
  body: string;
  status: PublicStatusEventStatus;
  components: PublicStatusComponentId[];
  startedAt: number;
  plannedEndAt: number | null;
  resolvedAt: number | null;
}

export interface StatusEventPatch {
  title?: string;
  body?: string;
  status?: PublicStatusEventStatus;
  components?: PublicStatusComponentId[];
  startedAt?: number;
  plannedEndAt?: number | null;
  resolvedAt?: number | null;
}

export interface StatusEventFilter {
  kind?: PublicStatusIncidentKind;
  /** 只看进行中的（事件未恢复、维护未完成）。 */
  active?: boolean;
  /** 只看这之后开始的（epoch 毫秒），缺省查全部。 */
  since?: number;
  limit: number;
  offset: number;
}

export interface StatusEventRepository {
  list(
    environment: string,
    filter: StatusEventFilter
  ): Promise<{
    items: PublicStatusEvent[];
    total: number;
  }>;
  get(environment: string, id: number): Promise<PublicStatusEvent | null>;
  create(environment: string, input: StatusEventInput): Promise<PublicStatusEvent>;
  update(environment: string, id: number, patch: StatusEventPatch): Promise<PublicStatusEvent>;
  remove(environment: string, id: number): Promise<void>;
}

const parseComponents = (raw: string): PublicStatusComponentId[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (id): id is PublicStatusComponentId =>
        typeof id === "string" && (PUBLIC_STATUS_COMPONENT_IDS as readonly string[]).includes(id)
    );
  } catch {
    return [];
  }
};

const toEvent = (row: typeof statusEvent.$inferSelect): PublicStatusEvent => {
  const status = isPublicStatusEventStatus(row.status) ? row.status : "investigating";
  return {
    id: row.id,
    kind: row.kind === "maintenance" ? "maintenance" : "incident",
    title: row.title,
    body: row.body,
    status,
    components: parseComponents(row.components),
    startedAt: row.startedAt.getTime(),
    plannedEndAt: row.plannedEndAt ? row.plannedEndAt.getTime() : null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.getTime() : null,
    updatedAt: row.updatedAt.getTime(),
  };
};

/** 进行中的判定只有一份：事件看 resolvedAt，维护看 done；排序与页面展示都按它。 */
export const isStatusEventActive = (event: PublicStatusEvent): boolean =>
  event.kind === "incident" ? event.resolvedAt === null : event.status !== "done";

/**
 * 状态事件的存储：故障事件与维护窗口同一张表，环境隔离与状态历史同口径。
 * 时间以 UTC 毫秒进出，`components` 存公开组件白名单的 JSON 数组，读出时重新过白名单。
 */
export class DatabaseStatusEventRepository implements StatusEventRepository {
  constructor(private readonly database: Database) {}

  async list(environment: string, filter: StatusEventFilter) {
    await this.database.ready;
    const conditions: SQL[] = [eq(statusEvent.environment, environment)];
    if (filter.kind) conditions.push(eq(statusEvent.kind, filter.kind));
    if (filter.since !== undefined)
      conditions.push(gte(statusEvent.startedAt, new Date(filter.since)));
    if (filter.active !== undefined) {
      const activeCondition = filter.active
        ? sql`${statusEvent.resolvedAt} is null and ${statusEvent.status} <> 'done'`
        : sql`(${statusEvent.resolvedAt} is not null or ${statusEvent.status} = 'done')`;
      conditions.push(activeCondition);
    }
    const where = and(...conditions);
    const [rows, [count]] = await Promise.all([
      this.database.db
        .select()
        .from(statusEvent)
        .where(where)
        .orderBy(desc(statusEvent.startedAt), desc(statusEvent.id))
        .limit(filter.limit)
        .offset(filter.offset),
      this.database.db
        .select({ total: sql<number>`count(*)` })
        .from(statusEvent)
        .where(where),
    ]);
    return { items: rows.map(toEvent), total: Number(count?.total ?? 0) };
  }

  async get(environment: string, id: number): Promise<PublicStatusEvent | null> {
    await this.database.ready;
    const rows = await this.database.db
      .select()
      .from(statusEvent)
      .where(and(eq(statusEvent.environment, environment), eq(statusEvent.id, id)))
      .limit(1);
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async create(environment: string, input: StatusEventInput): Promise<PublicStatusEvent> {
    await this.database.ready;
    const inserted = await this.database.db
      .insert(statusEvent)
      .values({
        environment,
        kind: input.kind,
        title: input.title,
        body: input.body,
        status: input.status,
        components: JSON.stringify(input.components),
        startedAt: new Date(input.startedAt),
        plannedEndAt: input.plannedEndAt === null ? null : new Date(input.plannedEndAt),
        resolvedAt: input.resolvedAt === null ? null : new Date(input.resolvedAt),
      })
      .$returningId();
    const created = await this.get(environment, inserted[0]!.id);
    if (!created) throw new AppError("STATUS_EVENT_LOST", "状态事件创建后读不回来");
    return created;
  }

  async update(
    environment: string,
    id: number,
    patch: StatusEventPatch
  ): Promise<PublicStatusEvent> {
    await this.database.ready;
    const values: Partial<typeof statusEvent.$inferInsert> = {};
    if (patch.title !== undefined) values.title = patch.title;
    if (patch.body !== undefined) values.body = patch.body;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.components !== undefined) values.components = JSON.stringify(patch.components);
    if (patch.startedAt !== undefined) values.startedAt = new Date(patch.startedAt);
    if (patch.plannedEndAt !== undefined)
      values.plannedEndAt = patch.plannedEndAt === null ? null : new Date(patch.plannedEndAt);
    if (patch.resolvedAt !== undefined)
      values.resolvedAt = patch.resolvedAt === null ? null : new Date(patch.resolvedAt);
    if (Object.keys(values).length > 0) {
      await this.database.db
        .update(statusEvent)
        .set(values)
        .where(and(eq(statusEvent.environment, environment), eq(statusEvent.id, id)));
    }
    const updated = await this.get(environment, id);
    if (!updated) throw new AppError("NOT_FOUND", "状态事件不存在");
    return updated;
  }

  async remove(environment: string, id: number): Promise<void> {
    await this.database.ready;
    await this.database.db
      .delete(statusEvent)
      .where(and(eq(statusEvent.environment, environment), eq(statusEvent.id, id)));
  }
}
