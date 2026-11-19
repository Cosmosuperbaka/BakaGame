import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageLoadingFallback } from "./PageLoadingFallback";

describe("PageLoadingFallback", () => {
  it("renders accessible loading indicator", () => {
    render(<PageLoadingFallback />);
    const indicator = screen.getByRole("status", { name: "页面加载中" });
    expect(indicator).toBeInTheDocument();
    expect(screen.getByText("页面加载中")).toBeInTheDocument();
  });
});
