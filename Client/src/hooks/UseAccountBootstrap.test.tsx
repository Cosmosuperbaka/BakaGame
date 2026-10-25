import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCloudSyncEnabled } from "@/lib/CloudSync";
import { useAccountStore } from "@/stores/UseAccountStore";
import { useAccountBootstrap } from "./UseAccountBootstrap";

const { startCloudSync, stopCloudSync } = vi.hoisted(() => {
  const stopCloudSync = vi.fn();
  return { startCloudSync: vi.fn(() => stopCloudSync), stopCloudSync };
});

vi.mock("@/lib/CloudSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/CloudSync")>();
  return { ...actual, startCloudSync };
});

vi.mock("@/lib/VisitReport", () => ({
  reportVisit: vi.fn(),
  visitSection: () => "home",
}));

const initialAccountState = useAccountStore.getState();

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>{children}</MemoryRouter>
);

afterEach(() => {
  useAccountStore.setState(initialAccountState, true);
  startCloudSync.mockClear();
  stopCloudSync.mockClear();
});

describe("useAccountBootstrap cloud sync switch", () => {
  it("关闭后不启动同步，重新开启才启动，再关闭立即停止", () => {
    setCloudSyncEnabled(false);
    useAccountStore.setState({ status: "signedIn", load: vi.fn(async () => {}) });

    renderHook(() => useAccountBootstrap(), { wrapper });
    expect(startCloudSync).not.toHaveBeenCalled();

    act(() => setCloudSyncEnabled(true));
    expect(startCloudSync).toHaveBeenCalledTimes(1);
    expect(stopCloudSync).not.toHaveBeenCalled();

    act(() => setCloudSyncEnabled(false));
    expect(stopCloudSync).toHaveBeenCalledTimes(1);
  });
});
