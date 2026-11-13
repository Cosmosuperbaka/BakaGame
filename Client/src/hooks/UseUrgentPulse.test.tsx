import { render, screen } from "@testing-library/react";
import { AnimatePresence, motion } from "framer-motion";
import { describe, expect, it } from "vitest";
import { useUrgentPulse } from "./UseUrgentPulse";

function Icon({ active, reduced = false }: { active: boolean; reduced?: boolean }) {
  const ref = useUrgentPulse<HTMLSpanElement>(active, reduced);
  return <span ref={ref} data-testid="icon" />;
}

/** 首屏挂载即在末段：模拟进房、重连时倒计时已在最后几秒，面板在 `initial={false}` 下挂载。 */
const mountInPresence = (props: { active: boolean; reduced?: boolean }) =>
  render(
    <AnimatePresence initial={false}>
      <motion.div key="panel">
        <Icon {...props} />
      </motion.div>
    </AnimatePresence>
  );

const scaleOf = () => {
  const match = /scale\(([\d.]+)\)/.exec(screen.getByTestId("icon").style.transform);
  return match ? Number(match[1]) : 1;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("useUrgentPulse", () => {
  it("首屏挂载时已在末段也照常起拍，不被当成首屏入场跳过", async () => {
    mountInPresence({ active: true });
    await wait(200);
    expect(scaleOf()).toBeGreaterThan(1);
  });

  it("不在末段或减弱动效时静止", async () => {
    mountInPresence({ active: false });
    mountInPresence({ active: true, reduced: true });
    await wait(200);
    for (const icon of screen.getAllByTestId("icon"))
      expect(icon.style.transform).not.toMatch(/scale\(1\.\d/);
  });
});
