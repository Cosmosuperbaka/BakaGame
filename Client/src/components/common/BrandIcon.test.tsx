import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BRAND_ICON_PATHS, type BrandIconName } from "@/data/BrandIconPaths";
import { BrandIcon } from "./BrandIcon";

describe("BrandIcon", () => {
  it.each(Object.keys(BRAND_ICON_PATHS) as BrandIconName[])("%s 渲染为装饰性内联 SVG", (name) => {
    const { container } = render(<BrandIcon name={name} className="text-base" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe(`0 0 ${BRAND_ICON_PATHS[name].width} 512`);
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.classList.contains("text-base")).toBe(true);
    expect(container.querySelector("path")?.getAttribute("d")).toBe(BRAND_ICON_PATHS[name].path);
    expect(container.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
  });

  it("盒尺寸走行内样式，压得过父级的 svg 尺寸规则", () => {
    const { container } = render(<BrandIcon name="github" />);
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg.style.width).toBe("1.25em");
    expect(svg.style.height).toBe("1em");
  });
});
