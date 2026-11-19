import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakerPendingSpeech } from "./FakerPendingSpeech";

const motionPreference = vi.hoisted(() => ({ reduced: false }));

vi.mock("framer-motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("framer-motion")>()),
  useReducedMotion: () => motionPreference.reduced,
}));

const dots = () =>
  Array.from(screen.getByRole("status", { name: "尚未发言" }).querySelectorAll("span"));

/** 等两帧多一点：循环若在跑，第一组关键帧早已写进行内样式。 */
const afterFrames = () => new Promise((resolve) => setTimeout(resolve, 120));

afterEach(() => {
  motionPreference.reduced = false;
});

describe("FakerPendingSpeech", () => {
  it("常规偏好下三点循环浮起，透明度在变", async () => {
    render(<FakerPendingSpeech />);
    await afterFrames();
    expect(dots().some((dot) => dot.style.opacity !== "" && Number(dot.style.opacity) < 1)).toBe(
      true
    );
  });

  it("减弱动效时三点静止、完全不透明，不再闪烁循环", async () => {
    motionPreference.reduced = true;
    render(<FakerPendingSpeech />);
    await afterFrames();
    for (const dot of dots()) {
      expect(dot.style.opacity === "" || dot.style.opacity === "1").toBe(true);
      expect(dot.style.transform === "" || dot.style.transform === "none").toBe(true);
    }
  });
});
