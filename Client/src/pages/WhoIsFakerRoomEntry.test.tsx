import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { deferred } from "@/test/Deferred";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWhoIsFakerStore, initWhoIsFakerWs } from "@/stores/UseWhoIsFakerStore";
import type { ServerMessage } from "@bakagame/shared";
import { getSessionToken, saveSessionToken, saveUsername } from "@/lib/Storage";
import { wifSnapshot } from "@/stories/fixtures/WhoIsFaker";
import WhoIsFakerRoomPage from "./WhoIsFakerRoomPage";
import { rejectedProtocol } from "@/lib/ProtocolFailure";

const { navigate, waitConnection, send, listeners } = vi.hoisted(() => ({
  navigate: vi.fn(),
  waitConnection: vi.fn(),
  send: vi.fn(),
  listeners: [] as Array<(message: ServerMessage) => void>,
}));
vi.mock("@/hooks/UsePageTransition", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/UsePageTransition")>()),
  usePageNavigate: () => navigate,
}));
vi.mock("@/lib/WhoIsFakerWs", () => ({
  waitForConnection: waitConnection,
  send,
  connect: vi.fn(),
  disconnect: vi.fn(),
  onMessage: (fn: (message: ServerMessage) => void) => {
    listeners.push(fn);
    return () => {
      listeners.splice(listeners.indexOf(fn), 1);
    };
  },
  onStatus: () => () => {},
}));
vi.mock("@/components/common/Seo", () => ({ Seo: () => null }));
vi.mock("@/components/common/ChatPanel", () => ({ ChatPanel: () => null }));
vi.mock("@/components/whoisfaker/layout/FakerGameArea", () => ({ FakerGameArea: () => null }));
vi.mock("@/components/whoisfaker/layout/FakerPlayerList", () => ({
  FakerPlayerList: () => null,
}));
vi.mock("@/components/whoisfaker/layout/FakerAssignedWord", () => ({
  FakerAssignedWord: () => null,
}));
const initial = useWhoIsFakerStore.getState();
/** 进房 ack 只有身份三元组；首屏快照与私有态走 event 通道，见 `WhoIsFakerRoomEnterAck`。 */
const receipt = () => ({ roomId: "1234", playerId: "player-1", sessionToken: "fixture-token" });
function mount(strict = false, roomId = "1234") {
  const router = (
    <MemoryRouter initialEntries={[`/whoisfaker/room/${roomId}`]}>
      <Routes>
        <Route path="/whoisfaker/room/:roomId" element={<WhoIsFakerRoomPage />} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{router}</StrictMode> : router);
}
/** 首屏快照只由 `room.snapshot` 事件下发：把它喂给 store 注册的 event 通道。 */
function emitSnapshot(roomId: string) {
  const message = {
    type: "event",
    event: "room.snapshot",
    payload: { mode: "full", revision: 1, state: { ...wifSnapshot("waiting"), roomId } },
  };
  listeners.forEach((handler) => handler(message as unknown as ServerMessage));
}
beforeEach(() => {
  vi.resetAllMocks();
  listeners.length = 0;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  useWhoIsFakerStore.setState({ ...initial, connected: true, showToast: vi.fn() }, true);
  waitConnection.mockResolvedValue(undefined);
  send.mockImplementation(async (type: string) => {
    if (type === "room.leave") return undefined;
    if (!["room.join", "room.create", "room.reconnect"].includes(type))
      throw new Error(`测试禁止命令 ${type}`);
    return receipt();
  });
  saveUsername("玩家");
});
afterEach(() => useWhoIsFakerStore.setState(initial, true));

describe("卧底直链入房归属（真实页面与Store，隔离WS）", () => {
  it("连接等待期间卸载不发入房或导航", async () => {
    const connection = deferred<void>();
    waitConnection.mockReturnValue(connection.promise);
    const view = mount();
    view.unmount();
    await act(async () => connection.resolve());
    expect(send).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("卸载后的成功加入只释放精确席位，不保存会话", async () => {
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockImplementation((type: string) =>
      type === "room.join" ? ack.promise : Promise.resolve()
    );
    const view = mount();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => ack.resolve(receipt()));
    expect(send.mock.calls[1]).toEqual([
      "room.leave",
      {},
      { roomId: "1234", sessionToken: "fixture-token" },
    ]);
    expect(useWhoIsFakerStore.getState().roomId).toBeNull();
    expect(getSessionToken("1234")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("卸载后房间不存在不接着创建，也不提示旧错误", async () => {
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockReturnValue(ack.promise);
    const view = mount();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => ack.reject({ code: "ROOM_NOT_FOUND" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(useWhoIsFakerStore.getState().showToast).not.toHaveBeenCalled();
  });
  it("创建沿用加入signal，晚ACK释放席位", async () => {
    const ack = deferred<ReturnType<typeof receipt>>();
    // 夹具复刻服务端 error 包的形状：被测代码读的是 code，不是 Error。
    send.mockImplementation((type: string) =>
      type === "room.join"
        ? rejectedProtocol({ code: "ROOM_NOT_FOUND", message: "房间不存在" })
        : type === "room.create"
          ? ack.promise
          : Promise.resolve()
    );
    const join = vi.fn(initial.joinRoom),
      create = vi.fn(initial.createRoom);
    useWhoIsFakerStore.setState({ joinRoom: join, createRoom: create });
    const view = mount();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][1]).toBe(join.mock.calls[0][3]);
    view.unmount();
    expect(join.mock.calls[0][3]?.aborted).toBe(true);
    await act(async () => ack.resolve(receipt()));
    expect(useWhoIsFakerStore.getState().roomId).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("StrictMode恢复共享单次请求，新effect接管不释放成功席位", async () => {
    saveSessionToken("1234", "saved-token");
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockReturnValue(ack.promise);
    const view = mount(true);
    await waitFor(() =>
      expect(send).toHaveBeenCalledExactlyOnceWith("room.reconnect", {
        roomId: "1234",
        sessionToken: "saved-token",
      })
    );
    await act(async () => ack.resolve(receipt()));
    expect(useWhoIsFakerStore.getState().roomId).toBe("1234");
    expect(getSessionToken("1234")).toBe("fixture-token");
    expect(send).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    view.unmount();
  });
  it("临时恢复失败保留令牌并退出，不自动加入或创建", async () => {
    saveSessionToken("1234", "saved-token");
    send.mockRejectedValue({ code: "DISCONNECTED", message: "暂时断开" });
    const view = mount();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/whoisfaker"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("room.reconnect");
    expect(getSessionToken("1234")).toBe("saved-token");
    view.unmount();
  });
  it("正常加入ACK保留身份不因快照更新取消，房间关闭才退出", async () => {
    const view = mount();
    await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    act(() => useWhoIsFakerStore.getState().markRoomClosed());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/whoisfaker", { replace: true }));
    view.unmount();
  });
  it("测试房小写直链按规范房号入房并离开加载态", async () => {
    const dispose = initWhoIsFakerWs();
    send.mockImplementation(async (type: string) => {
      if (type === "room.leave") return undefined;
      if (type !== "room.join") throw new Error(`测试禁止命令 ${type}`);
      // 服务端先把首屏快照推给这条连接，再回 ack；快照不在 ack 里。
      emitSnapshot("Oblivionis");
      return { ...receipt(), roomId: "Oblivionis" };
    });
    const view = mount(false, "oblivionis");
    await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("Oblivionis"));
    await waitFor(() => expect(screen.queryByText("正在加入房间...")).toBeNull());
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "room.join",
      { userName: "玩家", password: undefined },
      { roomId: "Oblivionis" }
    );
    expect(navigate).not.toHaveBeenCalled();
    view.unmount();
    dispose();
  });
  it("测试房小写直链刷新按规范房号恢复会话", async () => {
    saveSessionToken("Oblivionis", "saved-token");
    const dispose = initWhoIsFakerWs();
    send.mockImplementation(async (type: string) => {
      if (type === "room.leave") return undefined;
      if (type !== "room.reconnect") throw new Error(`测试禁止命令 ${type}`);
      emitSnapshot("Oblivionis");
      return { ...receipt(), roomId: "Oblivionis" };
    });
    const view = mount(false, "oblivionis");
    await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("Oblivionis"));
    await waitFor(() => expect(screen.queryByText("正在加入房间...")).toBeNull());
    expect(send).toHaveBeenCalledExactlyOnceWith("room.reconnect", {
      roomId: "Oblivionis",
      sessionToken: "saved-token",
    });
    expect(navigate).not.toHaveBeenCalled();
    view.unmount();
    dispose();
  });

  describe("私密房直链", () => {
    /** 无密码或密码不对都按服务端口径拒绝；只有密码为 secret 才放行。 */
    function lockRoom() {
      send.mockImplementation(async (type: string, payload?: { password?: string }) => {
        if (type === "room.leave") return undefined;
        if (type !== "room.join") throw new Error(`测试禁止命令 ${type}`);
        if (payload?.password === "secret") return receipt();
        return rejectedProtocol({ code: "PASSWORD_INCORRECT", message: "房间密码错误" });
      });
    }
    const typePassword = (value: string) =>
      fireEvent.change(screen.getByLabelText("房间密码"), { target: { value } });

    it("先出现密码步骤，不报错也不踢回大厅", async () => {
      lockRoom();
      const view = mount();
      await screen.findByLabelText("房间密码");
      expect(navigate).not.toHaveBeenCalled();
      expect(useWhoIsFakerStore.getState().showToast).not.toHaveBeenCalled();
      view.unmount();
    });
    it("输对密码后入房", async () => {
      lockRoom();
      const view = mount();
      await screen.findByLabelText("房间密码");
      typePassword("secret");
      fireEvent.click(screen.getByRole("button", { name: "加入房间" }));
      await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
      expect(send).toHaveBeenLastCalledWith(
        "room.join",
        { userName: "玩家", password: "secret" },
        { roomId: "1234" }
      );
      expect(navigate).not.toHaveBeenCalled();
      view.unmount();
    });
    it("输错密码仍留在密码步骤，可以重试", async () => {
      lockRoom();
      const view = mount();
      await screen.findByLabelText("房间密码");
      typePassword("wrong");
      fireEvent.click(screen.getByRole("button", { name: "加入房间" }));
      await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      const retry = await screen.findByLabelText("房间密码");
      expect(navigate).not.toHaveBeenCalled();
      expect(useWhoIsFakerStore.getState().roomId).toBeNull();
      fireEvent.change(retry, { target: { value: "secret" } });
      fireEvent.click(screen.getByRole("button", { name: "加入房间" }));
      await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
      view.unmount();
    });
    it("取消密码步骤回到大厅", async () => {
      lockRoom();
      const view = mount();
      await screen.findByLabelText("房间密码");
      fireEvent.click(screen.getByRole("button", { name: "返回大厅" }));
      await waitFor(() => expect(navigate).toHaveBeenCalledWith("/whoisfaker"));
      view.unmount();
    });
    it("缺密码同样进密码步", async () => {
      send.mockImplementation(async (type: string) =>
        type === "room.join"
          ? rejectedProtocol({ code: "PASSWORD_REQUIRED", message: "需要房间密码" })
          : undefined
      );
      const view = mount();
      await screen.findByLabelText("房间密码");
      expect(navigate).not.toHaveBeenCalled();
      expect(useWhoIsFakerStore.getState().showToast).not.toHaveBeenCalled();
      view.unmount();
    });
    it("尝试过多留在密码步，框下写原因不标红，不提示也不回大厅", async () => {
      send.mockImplementation(async (type: string) =>
        type === "room.join"
          ? rejectedProtocol({ code: "TOO_MANY_ATTEMPTS", message: "尝试次数过多" })
          : undefined
      );
      const view = mount();
      const field = await screen.findByLabelText("房间密码");
      expect(screen.getByRole("alert")).toHaveTextContent("尝试次数过多");
      expect(field).not.toHaveAttribute("aria-invalid");
      expect(navigate).not.toHaveBeenCalled();
      expect(useWhoIsFakerStore.getState().showToast).not.toHaveBeenCalled();
      view.unmount();
    });
    it("刚到密码步不写原因也不标红", async () => {
      lockRoom();
      const view = mount();
      const field = await screen.findByLabelText("房间密码");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(field).not.toHaveAttribute("aria-invalid");
      view.unmount();
    });
    it("输错密码：框下写原因并标红，不另弹提示", async () => {
      lockRoom();
      const view = mount();
      await screen.findByLabelText("房间密码");
      typePassword("wrong");
      fireEvent.click(screen.getByRole("button", { name: "加入房间" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("房间密码错误");
      expect(screen.getByLabelText("房间密码")).toHaveAttribute("aria-invalid", "true");
      expect(useWhoIsFakerStore.getState().showToast).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      view.unmount();
    });
    it("输错后再试多次被拒：同一个框下换成尝试过多的说法", async () => {
      let attempts = 0;
      send.mockImplementation(async (type: string, payload?: { password?: string }) => {
        if (type !== "room.join") return undefined;
        if (!payload?.password)
          return rejectedProtocol({ code: "PASSWORD_REQUIRED", message: "需要房间密码" });
        attempts += 1;
        return attempts === 1
          ? rejectedProtocol({ code: "PASSWORD_INCORRECT", message: "房间密码错误" })
          : rejectedProtocol({ code: "TOO_MANY_ATTEMPTS", message: "尝试次数过多" });
      });
      const view = mount();
      await screen.findByLabelText("房间密码");
      typePassword("wrong");
      fireEvent.click(screen.getByRole("button", { name: "加入房间" }));
      await screen.findByText("房间密码错误");
      typePassword("again");
      fireEvent.click(screen.getByRole("button", { name: "加入房间" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("尝试次数过多");
      expect(screen.getByLabelText("房间密码")).not.toHaveAttribute("aria-invalid");
      expect(navigate).not.toHaveBeenCalled();
      expect(useWhoIsFakerStore.getState().showToast).not.toHaveBeenCalled();
      view.unmount();
    });
    it("确认在途：密码框留着，确认钮转圈并挡住重复提交，旧的原因先撤下", async () => {
      const retry = deferred<ReturnType<typeof receipt>>();
      let attempts = 0;
      send.mockImplementation(async (type: string, payload?: { password?: string }) => {
        if (type !== "room.join") return undefined;
        if (!payload?.password)
          return rejectedProtocol({ code: "PASSWORD_REQUIRED", message: "需要房间密码" });
        attempts += 1;
        return attempts === 1
          ? rejectedProtocol({ code: "PASSWORD_INCORRECT", message: "房间密码错误" })
          : retry.promise;
      });
      const view = mount();
      await screen.findByLabelText("房间密码");
      typePassword("wrong");
      fireEvent.click(screen.getByRole("button", { name: "加入房间" }));
      await screen.findByText("房间密码错误");
      typePassword("secret");
      const submit = screen.getByRole("button", { name: "加入房间" });
      fireEvent.click(submit);
      await waitFor(() => expect(submit).toHaveAttribute("aria-busy", "true"));
      expect(submit).toBeDisabled();
      expect(screen.getByLabelText("房间密码")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      fireEvent.submit(submit.closest("form")!);
      expect(send).toHaveBeenCalledTimes(3);
      await act(async () => retry.resolve(receipt()));
      await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
      expect(navigate).not.toHaveBeenCalled();
      view.unmount();
    });
  });
});

describe("卧底直链入房的分支与去向（补充）", () => {
  const toast = () => useWhoIsFakerStore.getState().showToast;

  it("严格模式下直链加入只发一次入房", async () => {
    const view = mount(true);
    await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
    expect(send.mock.calls.filter(([type]) => type === "room.join")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    view.unmount();
  });
  it("严格模式下卸载的那一轮不留孤儿席位", async () => {
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockImplementation((type: string) => (type === "room.join" ? ack.promise : undefined));
    const view = mount(true);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => ack.resolve(receipt()));
    expect(send.mock.calls.map(([type]) => type)).toEqual(["room.join", "room.leave"]);
    expect(useWhoIsFakerStore.getState().roomId).toBeNull();
  });
  it("恢复因座位失效被拒：清掉旧凭据，改用名字加入", async () => {
    saveSessionToken("1234", "saved-token");
    send.mockImplementation(async (type: string) => {
      if (type === "room.reconnect")
        return rejectedProtocol({ code: "SESSION_INVALID", message: "座位失效" });
      return receipt();
    });
    const view = mount();
    await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
    expect(send.mock.calls.map(([type]) => type)).toEqual(["room.reconnect", "room.join"]);
    expect(getSessionToken("1234")).toBe("fixture-token");
    expect(navigate).not.toHaveBeenCalled();
    view.unmount();
  });
  it.each(["ROOM_NOT_FOUND", "PLAYER_KICKED"])(
    "恢复被 %s 永久拒绝：回大厅，不加入也不建房",
    async (code) => {
      saveSessionToken("1234", "saved-token");
      send.mockImplementation(async (type: string) => {
        if (type === "room.reconnect") return rejectedProtocol({ code, message: "回不去了" });
        throw new Error(`不该发出 ${type}`);
      });
      const view = mount();
      await waitFor(() =>
        expect(navigate).toHaveBeenCalledExactlyOnceWith("/whoisfaker", { replace: true })
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(getSessionToken("1234")).toBeNull();
      view.unmount();
    }
  );
  it("本机没有名字时弹名字框，空白名字不能提交，填名后记住并入房", async () => {
    window.localStorage.clear();
    const view = mount();
    await screen.findByLabelText("用户名");
    expect(send).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "  " } });
    fireEvent.submit(screen.getByLabelText("用户名").closest("form")!);
    expect(send).not.toHaveBeenCalled();
    expect(toast()).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: " 新玩家 " } });
    fireEvent.click(screen.getByRole("button", { name: "进入房间" }));
    await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "room.join",
      { userName: "新玩家", password: undefined },
      { roomId: "1234" }
    );
    expect(window.localStorage.getItem("bakagame:username")).toBe("新玩家");
    view.unmount();
  });
  it("取消名字框回到大厅", async () => {
    window.localStorage.clear();
    const view = mount();
    await screen.findByLabelText("用户名");
    fireEvent.click(screen.getByRole("button", { name: "返回大厅" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith("/whoisfaker"));
    view.unmount();
  });
  it("房间不存在就以名字建房", async () => {
    send.mockImplementation(async (type: string) => {
      if (type === "room.join")
        return rejectedProtocol({ code: "ROOM_NOT_FOUND", message: "房间不存在" });
      return receipt();
    });
    const view = mount();
    await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
    expect(send.mock.calls[1]).toEqual([
      "room.create",
      {
        roomId: "1234",
        name: "玩家的房间",
        visibility: "public",
        allowSpectators: true,
        userName: "玩家",
      },
    ]);
    expect(navigate).not.toHaveBeenCalled();
    view.unmount();
  });
  it("房间不存在且建房失败：提示后回大厅", async () => {
    send.mockImplementation(async (type: string) =>
      rejectedProtocol(
        type === "room.join"
          ? { code: "ROOM_NOT_FOUND", message: "房间不存在" }
          : { code: "INTERNAL", message: "" }
      )
    );
    const view = mount();
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith("/whoisfaker"));
    expect(toast()).toHaveBeenCalledExactlyOnceWith("创建房间失败", "error");
    view.unmount();
  });
  it("加入被其它业务拒绝：提示服务端文案后回大厅", async () => {
    send.mockImplementation(async () =>
      rejectedProtocol({ code: "ROOM_FULL", message: "房间已满" })
    );
    const view = mount();
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith("/whoisfaker"));
    expect(toast()).toHaveBeenCalledExactlyOnceWith("房间已满", "error");
    view.unmount();
  });
  it("等连接超时：提示后回大厅，不发入房", async () => {
    waitConnection.mockRejectedValue(new Error("timeout"));
    const view = mount();
    await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith("/whoisfaker"));
    expect(toast()).toHaveBeenCalledExactlyOnceWith("连接服务器超时，请刷新重试", "error");
    expect(waitConnection).toHaveBeenCalledWith(8000);
    expect(send).not.toHaveBeenCalled();
    view.unmount();
  });
  it("房号无效：提示后替换回大厅，不等连接", async () => {
    const view = mount(false, "bad id!");
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledExactlyOnceWith("/whoisfaker", { replace: true })
    );
    expect(toast()).toHaveBeenCalledExactlyOnceWith("房间号无效，请检查链接", "error");
    expect(waitConnection).not.toHaveBeenCalled();
    view.unmount();
  });
  it("挂载前留下的关闭标记不挡住这次进房", async () => {
    useWhoIsFakerStore.setState({ roomClosedAt: Date.now() - 5_000 });
    const view = mount();
    await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
    expect(navigate).not.toHaveBeenCalled();
    expect(useWhoIsFakerStore.getState().roomClosedAt).toBeNull();
    view.unmount();
  });
  it("入房途中房间被关：作废入房并替换回大厅，清掉关闭标记", async () => {
    const ack = deferred<ReturnType<typeof receipt>>();
    send.mockImplementation((type: string) => (type === "room.join" ? ack.promise : undefined));
    const view = mount();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    act(() => useWhoIsFakerStore.getState().markRoomClosed());
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/whoisfaker", { replace: true });
    expect(useWhoIsFakerStore.getState().roomClosedAt).toBeNull();
    await act(async () => ack.resolve(receipt()));
    expect(send.mock.calls.map(([type]) => type)).toEqual(["room.join", "room.leave"]);
    expect(useWhoIsFakerStore.getState().roomId).toBeNull();
    view.unmount();
  });
  it.each([
    ["room.closed", {}, "房间已关闭"],
    ["room.closed", { reason: "kicked" }, "你已被移出房间"],
    ["session.replaced", {}, "当前席位已在另一个标签页接管"],
  ])("入房之后收到 %s %o：提示并替换回大厅", async (event, extra, text) => {
    const dispose = initWhoIsFakerWs();
    send.mockImplementation(async (type: string) => {
      if (type !== "room.join") return undefined;
      emitSnapshot("1234");
      return receipt();
    });
    const view = mount();
    await waitFor(() => expect(screen.queryByText("正在加入房间...")).toBeNull());
    act(() =>
      listeners.forEach((handler) =>
        handler({
          type: "event",
          event,
          payload: { roomId: "1234", ...extra },
        } as unknown as ServerMessage)
      )
    );
    expect(toast()).toHaveBeenCalledWith(text, "error");
    expect(navigate).toHaveBeenCalledWith("/whoisfaker", { replace: true });
    view.unmount();
    dispose();
  });
  it("在房里时 store 脱离了房间（没有关闭标记）：自行回大厅，不替换历史", async () => {
    const view = mount();
    await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
    act(() => useWhoIsFakerStore.getState().leaveRoomState());
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/whoisfaker");
    view.unmount();
  });
  it("挂载同一毫秒留下的关闭标记：先替换回大厅，入房仍照常发出（现状）", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      useWhoIsFakerStore.setState({ roomClosedAt: now });
      const view = mount();
      expect(navigate).toHaveBeenCalledExactlyOnceWith("/whoisfaker", { replace: true });
      await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
      expect(send.mock.calls.map(([type]) => type)).toEqual(["room.join"]);
      view.unmount();
    } finally {
      clock.mockRestore();
    }
  });
  it("页面被直接卸载（没点离开）不退房", async () => {
    const view = mount();
    await waitFor(() => expect(useWhoIsFakerStore.getState().roomId).toBe("1234"));
    view.unmount();
    expect(send.mock.calls.map(([type]) => type)).toEqual(["room.join"]);
    expect(useWhoIsFakerStore.getState().roomId).toBe("1234");
  });
  it("点离开先回大厅（不替换历史），卸载后才退房；离开后的关闭事件仍会替换回大厅", async () => {
    const dispose = initWhoIsFakerWs();
    send.mockImplementation(async (type: string) => {
      if (type !== "room.join") return undefined;
      emitSnapshot("1234");
      return receipt();
    });
    const view = mount();
    await waitFor(() => expect(screen.queryByText("正在加入房间...")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "离开房间" }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/whoisfaker");
    expect(send.mock.calls.map(([type]) => type)).toEqual(["room.join"]);
    act(() => useWhoIsFakerStore.getState().markRoomClosed());
    expect(navigate).toHaveBeenLastCalledWith("/whoisfaker", { replace: true });
    view.unmount();
    await waitFor(() =>
      expect(send.mock.calls.map(([type]) => type)).toEqual(["room.join", "room.leave"])
    );
    dispose();
  });
});
