import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CoreTechEntry, CreditDependency } from "@/lib/Credits";
import { CreditsTechStack } from "./CreditsTechStack";

const dependency = (
  overrides: Partial<CreditDependency> & Pick<CreditDependency, "name" | "version">
): CreditDependency => ({
  license: "MIT",
  description: "",
  url: "",
  direct: true,
  scope: "development",
  dependencies: [],
  ...overrides,
});

const TYPESCRIPT: CoreTechEntry = {
  name: "TypeScript",
  role: "全仓编译与类型契约",
  icon: "typescript",
  category: "frontend",
  url: "https://www.typescriptlang.org",
  packageName: "typescript",
};

describe("CreditsTechStack", () => {
  it("同名包有多条安装时展示直接依赖的版本，不被传递副本顶替", () => {
    render(
      <CreditsTechStack
        techStack={[TYPESCRIPT]}
        dependencies={[
          dependency({ name: "typescript", version: "6.0.3", direct: false }),
          dependency({ name: "typescript", version: "7.0.2" }),
        ]}
      />
    );

    const card = screen.getByRole("link", { name: /TypeScript/ });
    expect(within(card).getByText("v7.0.2")).toBeInTheDocument();
    expect(within(card).queryByText("v6.0.3")).not.toBeInTheDocument();
  });
});
