import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultCEESettings } from "@bakagame/shared";
import { useCEEStore } from "@/stores/UseCEEStore";
import { restoreCEESettings } from "./CEEWaiting";

const initialStoreState = useCEEStore.getState();

describe("restoreCEESettings", () => {
  afterEach(() => {
    useCEEStore.setState(initialStoreState, true);
  });

  it("不使用目录时只发送玩法设置", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useCEEStore.setState({ sendCommand });
    const settings = createDefaultCEESettings(2020);

    await restoreCEESettings({ settings });

    expect(sendCommand).toHaveBeenCalledExactlyOnceWith("cee.room.settings", { settings });
  });

  it("使用目录时先同步目录再保存设置", async () => {
    const sendCommand = vi.fn().mockResolvedValue({});
    useCEEStore.setState({ sendCommand });
    const settings = { ...createDefaultCEESettings(2020), useIndex: true, indexId: 42 };

    await restoreCEESettings({ settings });

    expect(sendCommand.mock.calls.map(([type]) => type)).toEqual([
      "cee.directory.import",
      "cee.room.settings",
    ]);
    expect(sendCommand).toHaveBeenCalledWith("cee.directory.import", { indexId: 42 });
    expect(sendCommand).toHaveBeenCalledWith("cee.room.settings", { settings });
  });

  it("目录同步失败时整体放弃，不再保存可能抽不出题的设置", async () => {
    const sendCommand = vi.fn().mockRejectedValue(new Error("目录同步失败"));
    useCEEStore.setState({ sendCommand });
    const settings = { ...createDefaultCEESettings(2020), useIndex: true, indexId: 42 };

    await expect(restoreCEESettings({ settings })).rejects.toThrow("目录同步失败");
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });
});
