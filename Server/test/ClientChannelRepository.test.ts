import { describe, expect, test } from "bun:test";

import { ClientChannelRepository } from "../src/infrastructure/db/ClientChannelRepository";
import type { StoredClientDevice } from "../src/infrastructure/ClientChannel";
import { createDrizzleStub, rowOf, schema, stamp } from "./DrizzleStub";

const T0 = Date.parse("2026-01-02T03:04:05.678Z");
const T1 = T0 + 60_000;

const device = (overrides: Partial<StoredClientDevice> = {}): StoredClientDevice => ({
  clientId: "client-1",
  clientType: "desktop",
  platform: "windows",
  keyAlgorithm: "ed25519",
  publicKey: "raw-public-key",
  keyProtection: "hardware",
  attestationLevel: undefined,
  registeredAt: T0,
  lastSeenAt: T1,
  ...overrides,
});

describe("客户端通道设备仓储（连接桩）", () => {
  test("重新注册覆盖密钥保护与最近在线，并清空上一次的证明档位", async () => {
    const stub = createDrizzleStub();
    const repository = new ClientChannelRepository(stub.database);

    await repository.save(device({ attestationLevel: "trusted" }));

    const query = stub.queryAt(0);
    expect(query.statement).toContain("insert into `client_channel_device`");
    // 换密钥就是一条新行；同一把密钥重新注册时，上次验出的档位不能替「密钥已换」担保。
    expect(query.statement.split("on duplicate key update")[1]).toBe(
      " `key_protection` = ?, `attestation_level` = ?, `last_seen_at` = ?"
    );
    expect(query.params).toEqual([
      "client-1",
      "desktop",
      "windows",
      "ed25519",
      "raw-public-key",
      "hardware",
      "trusted",
      stamp(T0),
      stamp(T1),
      "hardware",
      "trusted",
      stamp(T1),
    ]);
  });

  test("桌面端没有平台证明时 attestation_level 落 null", async () => {
    const stub = createDrizzleStub();
    const repository = new ClientChannelRepository(stub.database);

    await repository.save(device());
    expect(stub.queryAt(0).params[6]).toBeNull();
  });

  test("读取还原毫秒时间戳与档位，缺行时返回 undefined", async () => {
    const stub = createDrizzleStub();
    const repository = new ClientChannelRepository(stub.database);

    stub.reply([
      rowOf(schema.clientChannelDevice, {
        clientId: "client-1",
        clientType: "mobile",
        platform: "android",
        keyAlgorithm: "ec-p256",
        publicKey: "k",
        keyProtection: "software",
        attestationLevel: "degraded",
        registeredAt: stamp(T0),
        lastSeenAt: stamp(T1),
      }),
    ]);
    expect(await repository.find("client-1")).toEqual({
      clientId: "client-1",
      clientType: "mobile",
      platform: "android",
      keyAlgorithm: "ec-p256",
      publicKey: "k",
      keyProtection: "software",
      attestationLevel: "degraded",
      registeredAt: T0,
      lastSeenAt: T1,
    });
    expect(stub.queryAt(0).params).toEqual(["client-1", 1]);

    stub.reset();
    stub.reply([]);
    expect(await repository.find("missing")).toBeUndefined();
  });

  test("缺列的旧行退回 undefined 档位，不冒充任何证明等级", async () => {
    const stub = createDrizzleStub();
    const repository = new ClientChannelRepository(stub.database);
    stub.reply([
      rowOf(schema.clientChannelDevice, {
        clientId: "client-1",
        clientType: "desktop",
        platform: "windows",
        keyAlgorithm: "ed25519",
        publicKey: "k",
        keyProtection: "hardware",
        attestationLevel: null,
        registeredAt: stamp(T0),
        lastSeenAt: stamp(T1),
      }),
    ]);

    expect(await repository.find("client-1")).toMatchObject({ attestationLevel: undefined });
  });

  test("心跳只推进最近在线时间，不碰密钥与档位", async () => {
    const stub = createDrizzleStub();
    const repository = new ClientChannelRepository(stub.database);

    await repository.touch("client-1", T1);
    const query = stub.queryAt(0);
    expect(query.statement).toBe(
      "update `client_channel_device` set `last_seen_at` = ? where `client_channel_device`.`client_id` = ?"
    );
    expect(query.params).toEqual([stamp(T1), "client-1"]);
  });

  test("迁移未就绪时准入读写整体失败", async () => {
    const stub = createDrizzleStub({ ready: Promise.reject(new Error("db down")) });
    const repository = new ClientChannelRepository(stub.database);

    await expect(repository.find("client-1")).rejects.toThrow("db down");
    expect(stub.queries).toHaveLength(0);
  });
});
