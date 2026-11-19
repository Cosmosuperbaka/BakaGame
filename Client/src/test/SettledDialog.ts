import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * 等弹窗落定再返回它。Radix 在内容挂载之后才登记弹层，并在随后的一次重渲染里给内容补上
 * `pointer-events: auto`。弹窗若是在异步回调之后才打开的（例如先试一次恢复座位再弹密码框），
 * 这几次渲染不在同一个 act 里：一出现就抓快照，机器忙的时候会抓到没补完样式的那一帧。
 */
export const settledDialog = async (): Promise<HTMLElement> => {
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(dialog.style.pointerEvents).toBe("auto"));
  return dialog;
};
