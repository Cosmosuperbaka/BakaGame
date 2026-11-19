import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CardTitle } from "./Card";

describe("CardTitle", () => {
  it("默认是三级标题，读屏能按标题导航；需要时可以换级别或退回普通块", () => {
    render(
      <>
        <CardTitle>默认</CardTitle>
        <CardTitle as="h2">二级</CardTitle>
        <CardTitle as="div">普通</CardTitle>
      </>
    );
    expect(screen.getByRole("heading", { level: 3, name: "默认" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "二级" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "普通" })).not.toBeInTheDocument();
  });
});
