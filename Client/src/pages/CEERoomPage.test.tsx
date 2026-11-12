import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCEEStore } from "@/stores/UseCEEStore";
import { CEE_NATIVE_ROOM_ID, ceePrivateState, ceeSnapshot } from "@/stories/fixtures/CEE";
import CEERoomPage from "./CEERoomPage";

// 房间页的入房流程由 UseCEERoomLifecycle 的测试负责；这里只关心「在房间里」时页面对壳做了什么。
const lifecycle = vi.hoisted(() => ({ roomId: "1234" }));
vi.mock("@/hooks/UseCEERoomLifecycle", () => ({
  CEE_PASSWORD_ERROR_CODES: new Set<string>(),
  useCEERoomLifecycle: () => ({
    roomId: lifecycle.roomId,
    connected: true,
    joining: false,
    needsJoin: false,
    name: "",
    setName: vi.fn(),
    password: "",
    setPassword: vi.fn(),
    error: "",
    errorCode: "",
    join: vi.fn(),
    leave: vi.fn(),
  }),
}));
vi.mock("@/components/cee/CEEGameArea", () => ({ CEEGameArea: () => null }));
vi.mock("@/components/cee/CEEPlayerList", () => ({ CEEPlayerList: () => null }));

const initial = useCEEStore.getState();
const setSecureScreen = vi.fn<(enabled: boolean) => void>();
const installShell = () => {
  window.__BAKA_CHANNEL__ = {
    clientType: "mobile",
    platform: "android",
    clientVersion: "1.0.0",
    setSecureScreen,
  };
};
const enterRoom = (antiCheat: boolean, roomId = CEE_NATIVE_ROOM_ID) => {
  lifecycle.roomId = roomId;
  useCEEStore.setState({
    connected: true,
    roomId,
    snapshot: ceeSnapshot({ roomId, bakaAntiCheat: antiCheat }),
    privateState: ceePrivateState(),
  });
};
const mount = () =>
  render(
    <MemoryRouter>
      <CEERoomPage />
    </MemoryRouter>
  );
/** 壳此刻的最终状态：最后一次调用的值（没调用过即未开启）。 */
const secureNow = () => setSecureScreen.mock.calls.at(-1)?.[0] ?? false;

beforeEach(() => {
  installShell();
});
afterEach(() => {
  useCEEStore.setState(initial, true);
  delete window.__BAKA_CHANNEL__;
  setSecureScreen.mockClear();
  lifecycle.roomId = "1234";
});

describe("CEE 房间页的窗口级防截屏", () => {
  it("进入反作弊房即开启，离开房间页恢复", () => {
    enterRoom(true);
    const view = mount();
    expect(secureNow()).toBe(true);
    view.unmount();
    expect(secureNow()).toBe(false);
  });

  it("普通房不开启", () => {
    enterRoom(false);
    mount();
    expect(setSecureScreen).not.toHaveBeenCalledWith(true);
  });

  it("从反作弊房换到普通房时关闭，换到另一间反作弊房时保持开启", async () => {
    enterRoom(true, "1234");
    mount();
    expect(secureNow()).toBe(true);
    await act(async () => enterRoom(true, "5678"));
    expect(secureNow()).toBe(true);
    await act(async () => enterRoom(false, "9012"));
    expect(secureNow()).toBe(false);
  });

  it("断线清空视图时关闭，重连回到反作弊房后重新开启", async () => {
    enterRoom(true);
    mount();
    expect(secureNow()).toBe(true);
    await act(async () => useCEEStore.setState({ snapshot: null, privateState: null }));
    expect(secureNow()).toBe(false);
    await act(async () => enterRoom(true));
    expect(secureNow()).toBe(true);
  });

  it("非壳环境静默跳过，不报错", () => {
    delete window.__BAKA_CHANNEL__;
    enterRoom(true);
    expect(() => mount().unmount()).not.toThrow();
    expect(setSecureScreen).not.toHaveBeenCalled();
  });
});
