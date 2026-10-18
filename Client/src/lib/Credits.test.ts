import { describe, expect, it } from "vitest";
import {
  CREDIT_DESCRIPTION_LIMIT,
  UNKNOWN_LICENSE,
  collectTransitiveDependencyNames,
  creditDependencyIndex,
  creditLicenseLabel,
  creditLicenseOptions,
  filterCreditDependencies,
  licenseBucket,
  sortModelsByRelease,
  type ContributingModel,
  type CreditDependency,
} from "./Credits";

const dependency = (overrides: Partial<CreditDependency>): CreditDependency => ({
  name: "react",
  version: "19.3.0",
  license: "MIT",
  description: "React is a JavaScript library for building user interfaces.",
  url: "https://react.dev",
  direct: true,
  scope: "runtime",
  dependencies: [],
  ...overrides,
});

describe("licenseBucket", () => {
  it("按包名首字母分桶，scoped 包跳过 @ 取 scope 首字母", () => {
    expect(licenseBucket("react")).toBe("r");
    expect(licenseBucket("@radix-ui/react-dialog")).toBe("r");
    expect(licenseBucket("@sentry/react")).toBe("s");
    expect(licenseBucket("Zod")).toBe("z");
  });

  it("非字母数字的极端包名落进 # 桶，不产生空键", () => {
    expect(licenseBucket("@")).toBe("#");
    expect(licenseBucket("")).toBe("#");
    expect(licenseBucket("_private")).toBe("#");
  });
});

describe("creditLicenseLabel", () => {
  it("未声明读成未知，SPDX 表达式原样保留", () => {
    expect(creditLicenseLabel(UNKNOWN_LICENSE)).toBe("未知");
    expect(creditLicenseLabel("(MIT OR CC0-1.0)")).toBe("(MIT OR CC0-1.0)");
  });
});

describe("creditLicenseOptions", () => {
  it("按包数从多到少排列，同数按标识升序，未知固定最后", () => {
    const options = creditLicenseOptions([
      dependency({ name: "a", license: "MIT" }),
      dependency({ name: "b", license: "ISC" }),
      dependency({ name: "c", license: "MIT" }),
      dependency({ name: "d", license: UNKNOWN_LICENSE }),
      dependency({ name: "e", license: "0BSD" }),
    ]);

    expect(options).toEqual([
      { license: "MIT", count: 2 },
      { license: "0BSD", count: 1 },
      { license: "ISC", count: 1 },
      { license: UNKNOWN_LICENSE, count: 1 },
    ]);
  });

  it("空清单没有筛选项", () => {
    expect(creditLicenseOptions([])).toEqual([]);
  });
});

describe("filterCreditDependencies", () => {
  const dependencies = [
    dependency({ name: "@radix-ui/react-dialog", version: "1.1.23", license: "MIT" }),
    dependency({ name: "sharp", version: "0.35.4", license: "Apache-2.0" }),
    dependency({ name: "react-dom", version: "19.3.0", license: "MIT" }),
    dependency({ name: "zod", version: "4.6.7", license: UNKNOWN_LICENSE }),
  ];

  it("关键词匹配包名、版本与许可证，大小写不敏感", () => {
    expect(filterCreditDependencies(dependencies, "REACT", null).map((item) => item.name)).toEqual([
      "@radix-ui/react-dialog",
      "react-dom",
    ]);
    expect(filterCreditDependencies(dependencies, "19.3", null).map((item) => item.name)).toEqual([
      "react-dom",
    ]);
    expect(filterCreditDependencies(dependencies, "apache", null).map((item) => item.name)).toEqual(
      ["sharp"]
    );
  });

  it("首尾空白不参与匹配，空串等于不过滤", () => {
    expect(filterCreditDependencies(dependencies, "   ", null)).toHaveLength(4);
    expect(
      filterCreditDependencies(dependencies, "  sharp  ", null).map((item) => item.name)
    ).toEqual(["sharp"]);
  });

  it("许可证筛选与关键词同时生效，null 表示全部 License", () => {
    expect(filterCreditDependencies(dependencies, "react", "MIT").map((item) => item.name)).toEqual(
      ["@radix-ui/react-dialog", "react-dom"]
    );
    expect(
      filterCreditDependencies(dependencies, "", "Apache-2.0").map((item) => item.name)
    ).toEqual(["sharp"]);
    expect(
      filterCreditDependencies(dependencies, "", UNKNOWN_LICENSE).map((item) => item.name)
    ).toEqual(["zod"]);
    expect(filterCreditDependencies(dependencies, "react", "Apache-2.0")).toEqual([]);
  });

  it("没有命中时返回空数组，输入不被修改", () => {
    const before = dependencies.map((item) => item.name);
    expect(filterCreditDependencies(dependencies, "不存在的包", null)).toEqual([]);
    expect(dependencies.map((item) => item.name)).toEqual(before);
  });
});

describe("sortModelsByRelease", () => {
  const models: ContributingModel[] = [
    { name: "Claude Opus 5", releasedAt: "2026-08-26", logo: "claude" },
    { name: "Claude Sonnet 4.6", releasedAt: "2026-01-22", logo: "claude" },
    { name: "Claude Opus 4.7", releasedAt: "2026-04-09", logo: "claude" },
    { name: "Claude Opus 4.6", releasedAt: "2026-01-22", logo: "claude" },
  ];

  it("同一公司内按发布时间从早到晚排列，同日按名称稳定排序", () => {
    expect(sortModelsByRelease(models).map((model) => model.name)).toEqual([
      "Claude Opus 4.6",
      "Claude Sonnet 4.6",
      "Claude Opus 4.7",
      "Claude Opus 5",
    ]);
  });

  it("返回新数组，不改动数据源顺序", () => {
    const before = models.map((model) => model.name);
    sortModelsByRelease(models);
    expect(models.map((model) => model.name)).toEqual(before);
  });
});

describe("依赖图", () => {
  const graph: CreditDependency[] = [
    dependency({
      name: "storybook",
      license: "MIT",
      dependencies: ["@storybook/react", "esbuild"],
    }),
    dependency({ name: "@storybook/react", license: "MIT", dependencies: ["react"] }),
    dependency({ name: "react", dependencies: [] }),
    dependency({ name: "esbuild", license: "MIT", dependencies: [] }),
    dependency({ name: "vite", license: "MIT", dependencies: ["esbuild"] }),
  ];
  const index = creditDependencyIndex(graph);

  it("按包名建立索引，取回原始条目", () => {
    expect(index.get("storybook")?.license).toBe("MIT");
    expect(index.get("missing")).toBeUndefined();
    expect(index.size).toBe(graph.length);
  });

  it("间接依赖是传递闭包，不含自身、去重并按包名排序", () => {
    expect(collectTransitiveDependencyNames(index, "storybook")).toEqual([
      "@storybook/react",
      "esbuild",
      "react",
    ]);
    expect(collectTransitiveDependencyNames(index, "vite")).toEqual(["esbuild"]);
    expect(collectTransitiveDependencyNames(index, "react")).toEqual([]);
    expect(collectTransitiveDependencyNames(index, "missing")).toEqual([]);
  });

  it("依赖图出现环时也能收敛（坏数据不让页面卡死）", () => {
    const cyclic = creditDependencyIndex([
      dependency({ name: "a", dependencies: ["b"] }),
      dependency({ name: "b", dependencies: ["a"] }),
    ]);
    expect(collectTransitiveDependencyNames(cyclic, "a")).toEqual(["b"]);
  });
});

describe("描述长度上限", () => {
  it("供构建期裁剪包简介使用", () => {
    expect(CREDIT_DESCRIPTION_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(CREDIT_DESCRIPTION_LIMIT)).toBe(true);
  });
});
