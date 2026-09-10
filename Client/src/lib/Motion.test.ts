import { describe, expect, it } from "vitest";
import { listItem } from "./Motion";

describe("Motion tokens", () => {
  it("listItem variants contract includes pointerEvents none on exit", () => {
    expect(listItem).toBeDefined();
    expect(listItem.initial).toMatchObject({ opacity: 0, scale: 0.94 });
    expect(listItem.animate).toMatchObject({ opacity: 1, scale: 1 });
    expect(listItem.exit).toMatchObject({
      opacity: 0,
      scale: 0.965,
      pointerEvents: "none",
    });
  });
});
