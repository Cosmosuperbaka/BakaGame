import { createRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverlayBackdrop } from "./OverlayBackdrop";

describe("OverlayBackdrop", () => {
  // 浮层基元靠这个引用拿到遮罩节点，判断退场动画有没有播完。
  it("把引用转发到遮罩元素上", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<OverlayBackdrop ref={ref} placement="viewport" />);
    expect(ref.current).toBe(container.firstElementChild);
  });

  it("外部类名并在档位类名之后，不替换档位类名", () => {
    const { container } = render(<OverlayBackdrop placement="container" className="extra" />);
    expect(container.firstElementChild?.className).toBe("scrim absolute inset-0 z-drawer extra");
  });
});
