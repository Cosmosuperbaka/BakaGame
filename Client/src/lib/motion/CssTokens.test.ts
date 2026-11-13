import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { duration, ease, spring } from "./Transitions";
import {
  creditsPage,
  installMotionTokens,
  motionCssVariables,
  motionTokenCss,
  pageScale,
} from "./CssTokens";
import { popover, popoverScale } from "./Choreography";
import {
  agentGesture,
  revealCard,
  roomEntrance,
  roomEntranceMs,
  springSettleMs,
} from "./NamedMoves";

describe("Motion tokens", () => {
  it("答案卡抬起：沉、抬、放三段关键帧与 times 对齐，投影时长与卡片放稳同刻，落定回到原大", () => {
    const { animate, transition } = revealCard;
    expect(animate.scale).toHaveLength(transition.times.length);
    expect(animate.y).toHaveLength(transition.times.length);
    expect(transition.ease).toHaveLength(transition.times.length - 1);
    expect(animate.y[1]).toBeGreaterThan(0);
    expect(Math.max(...animate.scale)).toBeGreaterThan(1);
    expect(animate.scale.at(-1)).toBe(1);
    expect(animate.y.at(-1)).toBe(0);
    expect(parseFloat(motionCssVariables()["reveal-lift-duration"])).toBeCloseTo(revealCard.settle);
  });

  it("版本信息页的开合行程写进 CSS 变量，与整页位移同一真相源", () => {
    expect(creditsPage.travel).toBe(100);
    expect(motionCssVariables()["page-credits-travel"]).toBe("100%");
  });

  it("popover 变体与 CSS 关键帧共用同一组起止尺度", () => {
    expect(popover.initial).toMatchObject({ scale: popoverScale.enter });
    expect(popover.exit).toMatchObject({ scale: popoverScale.exit });
    const variables = motionCssVariables();
    expect(variables["popover-enter-scale"]).toBe(String(popoverScale.enter));
    expect(variables["popover-exit-scale"]).toBe(String(popoverScale.exit));
  });

  it("进房编排的各栏延迟按 parts 顺序生成，窗口覆盖最后一栏的弹性落定", () => {
    const variables = motionCssVariables();
    const delays = roomEntrance.parts.map((part) =>
      parseFloat(variables[`room-entrance-delay-${part}`])
    );
    expect(delays).toEqual(
      roomEntrance.parts.map((_, index) => Number((index * roomEntrance.step).toFixed(3)))
    );
    expect(variables["room-entrance-scale"]).toBe(String(roomEntrance.scale));
    expect(roomEntranceMs).toBeGreaterThanOrEqual(
      Math.round(delays.at(-1)! * 1000) + springSettleMs(spring.swift)
    );
  });

  it("跨页过渡的前后两层尺度写进 CSS 变量，且后方小于 1、前方大于 1", () => {
    expect(pageScale.behind).toBeLessThan(1);
    expect(pageScale.ahead).toBeGreaterThan(1);
    const variables = motionCssVariables();
    expect(variables["page-behind-scale"]).toBe(String(pageScale.behind));
    expect(variables["page-ahead-scale"]).toBe(String(pageScale.ahead));
  });
});

describe("motionTokenCss", () => {
  it("曲线与时长直接取自 ease / duration 令牌", () => {
    const variables = motionCssVariables();
    expect(variables["ease-out"]).toBe(`cubic-bezier(${ease.out.join(", ")})`);
    expect(variables["ease-in-out"]).toBe(`cubic-bezier(${ease.inOut.join(", ")})`);
    expect(variables["ease-emphasized"]).toBe(`cubic-bezier(${ease.emphasized.join(", ")})`);
    expect(variables["duration-quick"]).toBe(`${duration.quick}s`);
    expect(variables["duration-base"]).toBe(`${duration.base}s`);
    expect(variables).not.toHaveProperty("duration-none");
    expect(variables).not.toHaveProperty("duration-hold");
  });

  it("每档弹性都有曲线与时长两个变量，减弱动效时只把弹性时长归零", () => {
    const css = motionTokenCss();
    for (const name of Object.keys(spring)) {
      expect(css).toContain(`--motion-spring-${name}: linear(`);
      expect(css).toMatch(new RegExp(`--motion-spring-${name}-duration: \\d`));
    }
    const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
    expect(reduced).toContain("--motion-spring-snap-duration: 0s;");
    expect(reduced).not.toContain("--motion-duration-quick");
  });

  it("揭晓投影的关键帧百分比由 revealCard 的分段生成：抬到最高处投影最远，其余时刻没有投影", () => {
    const css = motionTokenCss();
    const [start, sink, lift, end] = revealCard.transition.times.map((t) => `${t * 100}%`);
    expect(css).toContain(
      `@keyframes reveal-lift-shadow { ${start}, ${sink}, ${end} { opacity: 0; } ${lift} { opacity: 1; } }`
    );
  });

  it("Agent 手势的幅度经变量传给 CSS，关键帧不手抄数值", () => {
    const variables = motionCssVariables();
    expect(variables["agent-echo-opacity"]).toBe(String(agentGesture.echoOpacity));
    expect(variables["agent-echo-scale"]).toBe(String(agentGesture.echoScale));
    expect(variables["agent-bar-rise"]).toBe(agentGesture.barRise);
    expect(variables["agent-bar-scale"]).toBe(String(agentGesture.barScale));
    expect(variables["agent-nudge-scale"]).toBe(String(agentGesture.nudgeScale));
  });

  it("样式表里的动效关键帧不手抄幅度与百分比：投影关键帧只由脚本生成，Agent 手势读变量", () => {
    // 测试进程的当前目录约定为 Client 根（同 DesignTokens.test.ts）。
    const themeCss = readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf8");
    expect(themeCss).not.toMatch(/@keyframes\s+reveal-lift-shadow/);
    for (const name of ["agent-click-echo", "agent-bar-enter", "agent-bar-nudge"]) {
      const body = new RegExp(String.raw`@keyframes\s+${name}\s*\{([\s\S]*?)\r?\n\}`).exec(
        themeCss
      )?.[1];
      expect(body, name).toBeDefined();
      // 除了 0、1 这样的起止常量，关键帧里不应出现小数或带单位的幅度。
      expect(body?.replace(/var\(--motion-[\w-]+\)/g, ""), name).not.toMatch(
        /\d*\.\d+|\d+(rem|px)/
      );
    }
  });

  it("重复安装只更新同一个样式节点", () => {
    installMotionTokens();
    installMotionTokens();
    const nodes = document.head.querySelectorAll("style#motion-tokens");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].textContent).toBe(motionTokenCss());
  });
});
