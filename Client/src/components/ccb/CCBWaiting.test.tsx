import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultCCBSettings } from "@bakagame/shared";
import { useCCBStore } from "@/stores/UseCCBStore";
import { restoreCCBSettings } from "./CCBWaiting";

const initialStoreState = useCCBStore.getState();

describe("restoreCCBSettings", () => {
  afterEach(() => {
    useCCBStore.setState(initialStoreState, true);
  });

  it("不使用目录时只发送玩法设置", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useCCBStore.setState({ sendCommand });
    const settings = createDefaultCCBSettings(2020);

    await restoreCCBSettings({ settings });

    expect(sendCommand).toHaveBeenCalledExactlyOnceWith("ccb.room.settings", { settings });
  });

  it("使用目录时先同步目录再保存设置", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useCCBStore.setState({ sendCommand });
    const settings = { ...createDefaultCCBSettings(2020), useIndex: true, indexId: 42 };

    await restoreCCBSettings({ settings });

    expect(sendCommand.mock.calls.map(([type]) => type)).toEqual([
      "ccb.directory.import",
      "ccb.room.settings",
    ]);
    expect(sendCommand).toHaveBeenCalledWith("ccb.directory.import", { indexId: 42 });
    expect(sendCommand).toHaveBeenCalledWith("ccb.room.settings", { settings });
  });

  it("目录同步失败时整体放弃，不再保存可能抽不出题的设置", async () => {
    const sendCommand = vi.fn().mockRejectedValue(new Error("目录同步失败"));
    useCCBStore.setState({ sendCommand });
    const settings = { ...createDefaultCCBSettings(2020), useIndex: true, indexId: 42 };

    await expect(restoreCCBSettings({ settings })).rejects.toThrow("目录同步失败");
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
});
