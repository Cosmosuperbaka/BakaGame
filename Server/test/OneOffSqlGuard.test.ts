import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { confirmationMode, describeTarget } from "../scripts/RunOneOffSql";

test("回显目标只含主机、端口与库名，不含账号口令", () => {
  const target = describeTarget("mysql://admin:s3cret%40pw@db.example.com:3307/app_db?ssl=1");
  expect(target.label).toBe("db.example.com:3307/app_db");
  expect(target.label).not.toContain("s3cret");
  expect(target.label).not.toContain("admin");
  expect(describeTarget("mysql://u:p@db.example.com/app_db").label).toBe(
    "db.example.com:3306/app_db"
  );
});

test("连接地址不合法或缺库名时报错，且不回显原串", () => {
  expect(() => describeTarget("not a url with s3cret")).toThrow("不是合法的连接地址");
  try {
    describeTarget("not a url with s3cret");
  } catch (error) {
    expect(String(error)).not.toContain("s3cret");
  }
  expect(() => describeTarget("mysql://u:p@db.example.com/")).toThrow("缺少主机或库名");
});

test("非交互环境没有 --yes 一律拒绝，带了才放行；交互终端要求键入确认", () => {
  expect(confirmationMode([], false)).toBe("refuse");
  expect(confirmationMode(["a.sql"], false)).toBe("refuse");
  expect(confirmationMode(["a.sql", "--yes"], false)).toBe("skip");
  expect(confirmationMode(["a.sql"], true)).toBe("prompt");
});

test("真正执行前先回显目标并在无 --yes 时中止，不会去连库", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oneoff-guard-"));
  try {
    const sqlFile = path.join(dir, "change.sql");
    writeFileSync(sqlFile, "ALTER TABLE t ADD COLUMN c INT;\n");
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        "run",
        path.resolve(import.meta.dir, "../scripts/RunOneOffSql.ts"),
        sqlFile,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          DATABASE_URL: "mysql://admin:s3cret@db.example.com:3306/app_db",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("目标库：db.example.com:3306/app_db");
    expect(output).toContain("--yes");
    expect(output).not.toContain("s3cret");
    expect(output).not.toContain("完成");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
