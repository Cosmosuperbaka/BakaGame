import type { ProtocolError } from "./WebsocketClient";

/**
 * 协议错误体（`{ code, message }`）是数据契约：调用方按 `code` 分支，
 * 包成 `Error` 会丢掉 `code`，`isProtocolError` 也会判否。
 *
 * ESLint 的 `prefer-promise-reject-errors` 只接受 Error，因此把例外收敛到这两个
 * 函数里单点豁免；业务代码一律走这里，不再各自写 `eslint-disable`。
 */
export const rejectedProtocol = (error: ProtocolError): Promise<never> => {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- 协议错误体是数据契约，见本文件头注释
  return Promise.reject(error);
};

export const rejectProtocol = (
  reject: (reason: ProtocolError) => void,
  error: ProtocolError
): void => {
  reject(error);
};
