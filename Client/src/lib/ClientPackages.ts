import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/AdminFormat";
import { resolveServerUrl } from "@/lib/ServerEndpoint";

/**
 * 首页下载弹窗用的制品信息：地址、架构、文件大小与构建日期都由服务端
 * `GET /api/client/packages` 给（它对下载链发 HEAD 读回对象元数据）。
 *
 * 前端不再自己写死任何一项：写死的大小和日期在下次发版就成了假数据，
 * 而客户端一天不发版、页面一天就得跟着改。
 */

export type ClientPackagePlatform = "windows" | "android";

export interface ClientPackage {
  platform: ClientPackagePlatform;
  /** 安装包架构标签，如 `x64`、`全架构通用`。 */
  arch: string;
  url: string;
  /** 发布流水线写下的壳版本；旧制品没有旁文件时缺省。 */
  version?: string;
  /** 制品还没推上对象存储时为 false：弹窗把下载按钮置灰，而不是递一个 404 给玩家。 */
  available: boolean;
  sizeBytes?: number;
  /** 构建日期（ISO 串），来自制品对象的最后修改时间。 */
  builtAt?: string;
}

export interface ClientPackagesState {
  packages: ClientPackage[];
  /** 请求没成功（服务端不可达）：与「服务端说没有制品」是两件事，文案得区分。 */
  failed: boolean;
}

const EMPTY: ClientPackagesState = { packages: [], failed: true };

const isPackage = (value: unknown): value is ClientPackage => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.platform === "windows" || item.platform === "android") &&
    typeof item.url === "string" &&
    typeof item.arch === "string" &&
    typeof item.available === "boolean" &&
    (item.version === undefined || typeof item.version === "string")
  );
};

const parse = (body: unknown): ClientPackagesState => {
  const list = (body as { packages?: unknown })?.packages;
  return {
    packages: Array.isArray(list) ? list.filter(isPackage) : [],
    failed: !Array.isArray(list),
  };
};

/** 一次首页加载只问一次：弹窗与更新提醒要的是同一份数据。失败不进缓存，留给「重试」再问的机会。 */
let inflight: Promise<ClientPackagesState> | null = null;

const request = async (): Promise<ClientPackagesState> => {
  try {
    const response = await fetch(resolveServerUrl("/api/client/packages"));
    if (!response.ok) return EMPTY;
    return parse(await response.json());
  } catch {
    return EMPTY;
  }
};

export const loadClientPackages = (): Promise<ClientPackagesState> => {
  if (inflight) return inflight;
  const pending = request().then((state) => {
    if (state.failed && inflight === pending) inflight = null;
    return state;
  });
  inflight = pending;
  return pending;
};

/** `enabled` 为假时不发请求：入口按钮不该替没点开弹窗的玩家先问一次。 */
export const useClientPackages = (
  enabled = true
): {
  state: ClientPackagesState | null;
  reload: () => void;
} => {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<ClientPackagesState | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadClientPackages().then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [nonce, enabled]);

  return { state, reload: () => setNonce((value) => value + 1) };
};

/** `80.3 MB` / `6.8 MB`；读不到大小时返回空串，由调用处显示占位。 */
export const formatPackageSize = (bytes?: number): string => {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

/** 构建日期与站内其它时刻同样按北京时间写；读不到时返回空串。 */
export const formatPackageBuild = (builtAt?: string): string =>
  builtAt ? formatDateTime(builtAt) : "";
