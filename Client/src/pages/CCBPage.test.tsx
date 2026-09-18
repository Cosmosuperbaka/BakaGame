import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { HelmetProvider } from "react-helmet-async";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ccbWs } from "@/lib/CCBWs";
import { useCCBStore } from "@/stores/UseCCBStore";
import CCBPage from "./CCBPage";

afterEach(() => { useCCBStore.getState().resetRoom(); vi.restoreAllMocks(); });

it("从房间返回大厅时先离开原房且严格模式不重复提交退房", async () => {
  const send = vi.spyOn(ccbWs, "send").mockResolvedValue({ originalAvailable: false, sourceKey: "" });
  useCCBStore.setState({ connected: true, lobbyReady: true, source: "native", roomId: "1234", sessionToken: "token" });
  render(<StrictMode><HelmetProvider><MemoryRouter><CCBPage /></MemoryRouter></HelmetProvider></StrictMode>);
  await waitFor(() => expect(screen.getByRole("button", { name: "创建房间", exact: true })).toBeEnabled());
  expect(send.mock.calls.map(([command]) => command)).toEqual(["ccb.room.leave", "ccb.lobby.subscribeRooms"]);
  expect(useCCBStore.getState().roomId).toBeNull();
});
