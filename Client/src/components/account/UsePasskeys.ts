import { useCallback, useEffect, useRef, useState } from "react";
import {
  addPasskey,
  listPasskeys,
  passkeyErrorMessage,
  platformAuthenticatorAvailable,
  removePasskey,
  renamePasskey,
  type PasskeyAttachment,
  type PasskeyEntry,
} from "@/lib/Passkey";

export type PasskeyListState =
  | { status: "loading" }
  | { status: "ready"; items: PasskeyEntry[] }
  | { status: "error"; message: string };

const loadList = async (): Promise<PasskeyListState> => {
  try {
    return { status: "ready", items: await listPasskeys() };
  } catch (cause) {
    return { status: "error", message: passkeyErrorMessage(cause, "通行密钥读取失败") };
  }
};

export type PasskeyBusy = "add-platform" | "add-cross-platform" | "remove" | "rename";

/**
 * 通行密钥列表与增删改：库里的密钥以服务端为准，每次变更后重取列表，本地不拼差。
 * 初次加载就是一次 `reload`；卸载后回来的在途结果一律丢弃，不对已关闭的弹窗白做渲染。
 */
export function usePasskeys() {
  const [state, setState] = useState<PasskeyListState>({ status: "loading" });
  const [busy, setBusy] = useState<PasskeyBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 只在明确为 false 时禁用「本机解锁」；浏览器不给答案（undefined）时不能替玩家下结论。 */
  const [platformAuthenticator, setPlatformAuthenticator] = useState<boolean | undefined>(
    undefined
  );
  const alive = useRef(true);

  const reload = useCallback(async () => {
    const next = await loadList();
    if (alive.current) setState(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    // 初次加载与变更后的重取共用 loadList：读取与错误文案只写这一处。
    void loadList().then((next) => alive.current && setState(next));
    void platformAuthenticatorAvailable().then(
      (available) => alive.current && setPlatformAuthenticator(available)
    );
    return () => {
      alive.current = false;
    };
  }, []);

  /** 跑一次带忙碌态与错误提示的变更，成功后重取列表；返回是否成功。 */
  const mutate = async (
    kind: PasskeyBusy,
    action: () => Promise<void>,
    failure: (cause: unknown) => string,
    settled?: () => void
  ): Promise<boolean> => {
    setBusy(kind);
    setError(null);
    try {
      try {
        await action();
      } finally {
        // 请求一落定（成败都算）调用方就能收起自己的临时界面，不必等列表重取。
        settled?.();
      }
      await reload();
      return true;
    } catch (cause) {
      if (alive.current) setError(failure(cause));
      return false;
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const add = (attachment: PasskeyAttachment) =>
    mutate(
      attachment === "platform" ? "add-platform" : "add-cross-platform",
      () => addPasskey(attachment),
      (cause) =>
        passkeyErrorMessage(cause, "通行密钥添加失败，请稍后重试", {
          attachment,
          platformAuthenticator,
        })
    );

  const remove = (id: string) =>
    mutate(
      "remove",
      () => removePasskey(id),
      (cause) => passkeyErrorMessage(cause, "通行密钥移除失败，请稍后重试")
    );

  const rename = (id: string, name: string, settled: () => void) =>
    mutate(
      "rename",
      () => renamePasskey(id, name),
      (cause) => passkeyErrorMessage(cause, "通行密钥改名失败，请稍后重试"),
      settled
    );

  return { state, busy, error, platformAuthenticator, add, remove, rename };
}
