import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { parseBangumiMarkup } from "@/lib/BangumiMarkup";
import { BangumiRichText } from "./BangumiRichText";

describe("BangumiRichText", () => {
  it("渲染链接、粗斜体与小标题，未知方括号原样保留", () => {
    const { container } = render(
      <BangumiRichText text={"[size=22]简介[/size]\r\n由[url=https://bangumi.tv/person/1]某社[/url]制作，[b]粗[/b][i]斜[/i]，[jack]保留，见[url]https://weibo.com/x[/url]"} />,
    );
    const link = screen.getByRole("link", { name: "某社" });
    expect(link).toHaveAttribute("href", "https://bangumi.tv/person/1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("link", { name: "https://weibo.com/x" })).toHaveAttribute("href", "https://weibo.com/x");
    expect(container.querySelector("strong")).toHaveTextContent("粗");
    expect(container.querySelector("em")).toHaveTextContent("斜");
    expect(container).toHaveTextContent("[jack]保留");
    expect(container.textContent).not.toContain("[size");
  });

  it("只放行 http(s) 链接，其他协议只留文字", () => {
    render(<BangumiRichText text="[url=javascript:alert(1)]点我[/url]" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("点我")).toBeInTheDocument();
  });

  it("剧透遮罩点按后揭开，揭开前读屏只报剧透", () => {
    render(<BangumiRichText text="结局是[mask]主角[/mask]。" />);
    const spoiler = screen.getByRole("button", { name: /剧透/ });
    fireEvent.click(spoiler);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("主角")).toBeInTheDocument();
  });

  it("未闭合或错位的标记退回文字，不吞内容", () => {
    const flatten = (text: string) => JSON.stringify(parseBangumiMarkup(text));
    expect(flatten("[b]未闭合")).toBe(JSON.stringify(["[b]未闭合"]));
    expect(flatten("多余[/i]闭合")).toBe(JSON.stringify(["多余[/i]闭合"]));
    const crossed = parseBangumiMarkup("[b]外[i]内[/b]后[/i]");
    expect(crossed).toEqual([{ tag: "b", value: undefined, raw: "[b]", children: ["外[i]内"] }, "后[/i]"]);
  });
});
