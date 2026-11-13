import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => vi.fn());
vi.mock("@/lib/Sentry", () => ({ captureClientException: capture }));

import { AppErrorBoundary } from "./AppErrorBoundary";

function Boom(): never {
  throw new Error("渲染崩溃");
}

describe("AppErrorBoundary", () => {
  it("渲染异常时显示回退界面，先上报再调用恢复回调", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();
    render(
      <AppErrorBoundary fallback={<p>出错了</p>} onError={onError}>
        <Boom />
      </AppErrorBoundary>
    );
    expect(screen.getByText("出错了")).toBeTruthy();
    expect(capture).toHaveBeenCalledTimes(1);
    expect((capture.mock.calls[0]?.[0] as Error).message).toBe("渲染崩溃");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(capture.mock.invocationCallOrder[0]).toBeLessThan(
      onError.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("没有异常时原样渲染子节点", () => {
    render(
      <AppErrorBoundary fallback={<p>出错了</p>}>
        <p>正常内容</p>
      </AppErrorBoundary>
    );
    expect(screen.getByText("正常内容")).toBeTruthy();
    expect(screen.queryByText("出错了")).toBeNull();
  });
});
