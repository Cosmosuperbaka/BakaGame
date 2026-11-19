import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  MIRROR_DEGRADED,
  MIRROR_HEALTHY,
  MIRROR_READER,
  MIRROR_STALE,
} from "@/stories/fixtures/BangumiMirror";
import { BangumiMirrorView } from "./BangumiMirrorPanel";

const rowOf = (name: string) => screen.getByRole("row", { name: new RegExp(`^${name}`) });

describe("Bangumi 镜像面板", () => {
  it("正常时给出结论、数量、任务结果与下次计划", () => {
    render(<BangumiMirrorView status={MIRROR_HEALTHY} />);
    expect(screen.getByText("更新正常，没有超期或失败的任务")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "需要处理的问题" })).not.toBeInTheDocument();
    expect(screen.getAllByText("36,342")).toHaveLength(3);
    expect(screen.getAllByText("223,204")).toHaveLength(2);
    expect(screen.getByText("14.5 次/秒")).toBeInTheDocument();
    expect(screen.getByText("本地数据")).toBeInTheDocument();
    expect(within(rowOf("新条目发现")).getByText("成功")).toBeInTheDocument();
    expect(within(rowOf("新条目发现")).getByText(/入库 42/)).toBeInTheDocument();
    expect(within(rowOf("角色标签增量")).getByText("未配置")).toBeInTheDocument();
  });

  it("超期与失败逐条列出，提示不只靠颜色", () => {
    render(<BangumiMirrorView status={MIRROR_STALE} />);
    const alerts = within(screen.getByRole("list", { name: "需要处理的问题" }));
    expect(alerts.getByText("作品数据已超过 3 天没有成功刷新")).toBeInTheDocument();
    expect(alerts.getAllByText("故障")).toHaveLength(1);
    expect(alerts.getAllByText("注意")).toHaveLength(3);
    const discovery = within(rowOf("新条目发现"));
    expect(discovery.getByText("失败")).toBeInTheDocument();
    expect(discovery.getByText("新条目发现失败：新条目搜索失败：HTTP 503")).toBeInTheDocument();
    expect(within(rowOf("角色标签增量")).getByText("失败")).toBeInTheDocument();
  });

  it("数据集不可读时仍展示回源、更新器与搜索的状态", () => {
    render(<BangumiMirrorView status={MIRROR_DEGRADED} />);
    expect(screen.queryByText("作品")).not.toBeInTheDocument();
    expect(screen.queryByText("数据新鲜度")).not.toBeInTheDocument();
    expect(screen.getByText("网络回源")).toBeInTheDocument();
    expect(screen.getByText("BANGUMI_DATA_UNAVAILABLE")).toBeInTheDocument();
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(screen.getByText("不可用")).toBeInTheDocument();
    expect(within(rowOf("新条目发现")).getByText("暂无记录")).toBeInTheDocument();
  });

  it("只读分片说明更新由主分片负责，没有真实刷新时不假装有时间", () => {
    render(<BangumiMirrorView status={MIRROR_READER} />);
    expect(screen.getByText("由主分片负责")).toBeInTheDocument();
    expect(screen.getByText("尚无")).toBeInTheDocument();
    expect(screen.getAllByText("未配置").length).toBeGreaterThanOrEqual(1);
  });
});
