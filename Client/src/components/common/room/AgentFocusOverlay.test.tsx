import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentFocusEvent } from "@bakagame/shared";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { AgentFocusOverlay } from "./AgentFocusOverlay";

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

const focus = (overrides: Partial<AgentFocusEvent>): AgentFocusEvent => ({
  agentName: "BakaAgent",
  tool: "ui_run",
  game: "faker",
  kind: "chat",
  part: "chat",
  action: "focus",
  at: Date.now(),
  ...overrides,
});

describe("AgentFocusOverlay", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.dataset.agentControl === "chat.input") return rect(200, 300, 100, 30);
      if (this.dataset.agentControl === "chat.send") return rect(320, 300, 30, 30);
      return rect(0, 0, 800, 600);
    });
  });

  afterEach(async () => {
    await act(async () => {
      useWhoIsFakerStore.setState({ agentFocus: null });
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("把 Agent 键入的文字直接写进真实输入框，状态条贴着输入框居中而不是整页居中", async () => {
    render(
      <>
        <input data-agent-control="chat.input" aria-label="聊天消息" readOnly />
        <button data-agent-control="chat.send" type="button">
          发送
        </button>
        <AgentFocusOverlay game="faker" />
      </>
    );

    await act(async () => {
      useWhoIsFakerStore.setState({
        agentFocus: focus({
          controlId: "chat.input",
          label: "聊天消息",
          action: "type",
          input: "大家好",
        }),
      });
    });

    const input = screen.getByLabelText("聊天消息") as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("大家好"));
    expect(screen.getByRole("status")).toHaveTextContent("正在输入 · 聊天消息");
    expect(screen.getByRole("status")).not.toHaveTextContent("大家好");

    const hud = document.querySelector<HTMLElement>(".agent-focus-hud");
    expect(hud).not.toBeNull();
    expect(Number.parseFloat(hud!.style.left)).toBeCloseTo(250, 0);
    expect(hud!.style.top).toBe("259px");
  });

  it("点击发送后像人类一样清空输入框", async () => {
    render(
      <>
        <input data-agent-control="chat.input" aria-label="聊天消息" readOnly />
        <button data-agent-control="chat.send" type="button">
          发送
        </button>
        <AgentFocusOverlay game="faker" />
      </>
    );
    const input = screen.getByLabelText("聊天消息") as HTMLInputElement;

    await act(async () => {
      useWhoIsFakerStore.setState({
        agentFocus: focus({
          controlId: "chat.input",
          label: "聊天消息",
          action: "type",
          input: "待发送",
        }),
      });
    });
    await waitFor(() => expect(input.value).toBe("待发送"));

    await act(async () => {
      useWhoIsFakerStore.setState({
        agentFocus: focus({
          controlId: "chat.send",
          label: "发送消息",
          action: "click",
          at: Date.now() + 1,
        }),
      });
    });
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.getByRole("status")).toHaveTextContent("正在点击 · 发送消息");
  });
});
