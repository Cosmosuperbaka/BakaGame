import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("是行内元素，放进段落与按钮里不构成非法嵌套", () => {
    render(
      <p>
        房间 <Badge>等待中</Badge>
      </p>
    );
    expect(screen.getByText("等待中").tagName).toBe("SPAN");
  });

  it("引用指向它自己的元素", () => {
    const ref = createRef<HTMLSpanElement>();
    render(<Badge ref={ref}>可旁观</Badge>);
    expect(ref.current).toBe(screen.getByText("可旁观"));
  });
});
