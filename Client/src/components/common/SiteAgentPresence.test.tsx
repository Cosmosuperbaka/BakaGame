import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SiteAgentPresence } from "./SiteAgentPresence";
import {
  removeSiteAgent,
  resetSiteAgents,
  setSiteAgents,
  upsertSiteAgent,
  type SiteAgent,
} from "@/stores/UseSiteAgents";

const agent = (overrides: Partial<SiteAgent> = {}): SiteAgent => ({
  id: "conn-1",
  agentName: "BakaAgent",
  tool: "visit_page",
  kind: "site",
  page: "/abouts",
  at: Date.now(),
  ...overrides,
});

afterEach(() => resetSiteAgents());

describe("首页 Agent 活动指示", () => {
  it("没有 Agent 时不占布局", () => {
    const { container } = render(<SiteAgentPresence />);
    expect(container).toBeEmptyDOMElement();
  });

  it("显示 Agent 名称与位置，label 优先于泛化文案", () => {
    render(<SiteAgentPresence />);
    act(() => setSiteAgents([agent({ label: "关于项目" })]));
    expect(screen.getByText("BakaAgent")).toBeInTheDocument();
    expect(screen.getByText("关于项目")).toBeInTheDocument();

    act(() => upsertSiteAgent(agent({ id: "conn-1", kind: "lobby", label: undefined })));
    expect(screen.getByText("正在查看大厅")).toBeInTheDocument();
    expect(screen.queryByText("关于项目")).not.toBeInTheDocument();
  });

  it("Agent 离开后指示消失", () => {
    render(<SiteAgentPresence />);
    act(() => setSiteAgents([agent()]));
    expect(screen.getByText("BakaAgent")).toBeInTheDocument();
    act(() => removeSiteAgent("conn-1"));
    expect(screen.queryByText("BakaAgent")).not.toBeInTheDocument();
  });

  it("超过两条时折叠为 +N", () => {
    render(<SiteAgentPresence />);
    act(() =>
      setSiteAgents([
        agent({ id: "a", agentName: "AgentA" }),
        agent({ id: "b", agentName: "AgentB" }),
        agent({ id: "c", agentName: "AgentC" }),
      ])
    );
    expect(screen.getByText("AgentA")).toBeInTheDocument();
    expect(screen.queryByText("AgentC")).not.toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
  });
});
