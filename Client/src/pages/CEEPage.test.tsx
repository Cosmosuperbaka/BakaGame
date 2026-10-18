import { StrictMode, type ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  peekPendingRestore,
  readRoomCreateDefaults,
  saveRoomCreateDefaults,
} from "@/lib/RoomSettingsMemory";
import { useCEEStore } from "@/stores/UseCEEStore";
import CEEPage from "./CEEPage";
vi.mock("@/hooks/UsePageTransition", () => ({ usePageNavigate: () => vi.fn() }));
vi.mock("@/components/common/lobby/LobbyPage", () => ({
  LobbyPage: ({ disabled, dialogs }: { disabled: boolean; dialogs?: ReactNode }) => (
    <div>
      <button disabled={disabled}>加入房间</button>
      {dialogs}
    </div>
  ),
}));
// 捕获弹窗收到的 props：据此断言默认值，并用弹窗提交回调模拟建房。
const dialogProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@/components/common/CreateRoomDialog", () => ({
  CreateRoomDialog: (props: Record<string, unknown>) => {
    dialogProps.current = props;
    return null;
  },
}));
const initial = useCEEStore.getState();
afterEach(() => {
  useCEEStore.setState(initial, true);
  window.localStorage.clear();
  dialogProps.current = null;
});
function releaseFixture() {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const leave = vi.fn(() => pending);
  const subscribe = vi.fn().mockResolvedValue(undefined);
  useCEEStore.setState({
    roomId: "1234",
    connected: true,
    lobbyReady: true,
    leaveRoom: leave,
    subscribeLobby: subscribe,
  });
  return { resolve, leave, subscribe };
}
it("StrictMode 返回大厅只退房一次，当前挂载在退房完成后订阅大厅", async () => {
  const fixture = releaseFixture();
  render(
    <StrictMode>
      <CEEPage />
    </StrictMode>
  );
  expect(fixture.leave).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "加入房间" })).toBeDisabled();
  await act(async () => fixture.resolve());
  await waitFor(() => expect(screen.getByRole("button", { name: "加入房间" })).toBeEnabled());
  expect(fixture.subscribe).toHaveBeenCalledOnce();
});
it("大厅已经卸载时退房晚响应不再订阅", async () => {
  const fixture = releaseFixture();
  const h = render(<CEEPage />);
  h.unmount();
  await act(async () => fixture.resolve());
  expect(fixture.subscribe).not.toHaveBeenCalled();
});
it("创建时沿用同服务器的上次选项，成功后就地记住本次选项并登记恢复", async () => {
  localStorage.setItem("bakagame:username", "玩家");
  saveRoomCreateDefaults("cee", {
    visibility: "private",
    allowSpectators: false,
    source: "native",
  });
  const createRoom = vi.fn().mockResolvedValue(undefined);
  useCEEStore.setState({ createRoom });
  render(<CEEPage />);

  // 弹窗的默认值来自记忆（source 与当前服务器一致）。
  expect(dialogProps.current?.defaults).toEqual({
    visibility: "private",
    allowSpectators: false,
    source: "native",
  });

  // 模拟弹窗提交：这次改为公开、允许旁观。
  const onCreate = dialogProps.current?.onCreate as (
    params: Record<string, unknown>
  ) => Promise<void>;
  await act(async () => {
    await onCreate({ name: "新房", visibility: "public", allowSpectators: true });
  });

  expect(createRoom).toHaveBeenCalledWith(
    expect.objectContaining({ source: "native", visibility: "public", allowSpectators: true }),
    expect.any(AbortSignal)
  );
  // 本次选项覆盖记忆，标记登记为新房，等待页据此恢复玩法设置。
  expect(readRoomCreateDefaults("cee")).toEqual({
    visibility: "public",
    allowSpectators: true,
    source: "native",
  });
  expect(peekPendingRestore("cee")).toBe(String(createRoom.mock.calls[0]?.[0]?.roomId));
});
it("切到兼容原版后建房：旁观强制允许，记忆带 original 来源", async () => {
  localStorage.setItem("bakagame:username", "玩家");
  const createRoom = vi.fn().mockResolvedValue(undefined);
  useCEEStore.setState({ createRoom });
  render(<CEEPage />);

  const roomMode = dialogProps.current?.roomMode as { onCheckedChange: (checked: boolean) => void };
  act(() => roomMode.onCheckedChange(true));

  // 重新 render 后弹窗拿到原版房的语义：source=original 的记忆与当前服务器一致时才沿用。
  expect(dialogProps.current?.privacy).toBe("unlisted");
  const onCreate = dialogProps.current?.onCreate as (
    params: Record<string, unknown>
  ) => Promise<void>;
  await act(async () => {
    await onCreate({ name: "原版房", visibility: "private", allowSpectators: false });
  });

  expect(createRoom).toHaveBeenCalledWith(
    expect.objectContaining({ source: "original", allowSpectators: true }),
    expect.any(AbortSignal)
  );
  expect(readRoomCreateDefaults("cee")).toEqual({
    visibility: "private",
    allowSpectators: true,
    source: "original",
  });
});
