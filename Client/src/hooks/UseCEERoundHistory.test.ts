import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import type { CEERoomSnapshot } from "@bakagame/shared";
import { useCEERoundHistory } from "./UseCEERoundHistory";

/** 只填回放历史读取的字段。 */
const settled = (roomId: string, roundNumber: number): CEERoomSnapshot =>
  ({
    roomId,
    phase: "settled",
    roundNumber,
    roundSummary: { answer: { id: roundNumber }, guesses: [] },
  }) as unknown as CEERoomSnapshot;

const numbers = (rounds: { number: number }[]) => rounds.map((round) => round.number);

it("同一局里按回合累积，重复快照按回合号去重", () => {
  const { result, rerender } = renderHook(({ snapshot }) => useCEERoundHistory(snapshot), {
    initialProps: { snapshot: settled("1234", 1) as CEERoomSnapshot | null },
  });
  rerender({ snapshot: settled("1234", 1) });
  rerender({ snapshot: settled("1234", 2) });
  expect(numbers(result.current)).toEqual([1, 2]);
});

it("断线重连回到同一局（快照先置空、回合号不倒退）时保留已有历史", () => {
  const { result, rerender } = renderHook(({ snapshot }) => useCEERoundHistory(snapshot), {
    initialProps: { snapshot: settled("1234", 1) as CEERoomSnapshot | null },
  });
  rerender({ snapshot: settled("1234", 2) });
  rerender({ snapshot: null });
  rerender({ snapshot: settled("1234", 2) });
  expect(numbers(result.current)).toEqual([1, 2]);
});

it("快照置空后重进同号的新一局（回合号从头开始）时历史清空", () => {
  const { result, rerender } = renderHook(({ snapshot }) => useCEERoundHistory(snapshot), {
    initialProps: { snapshot: settled("1234", 1) as CEERoomSnapshot | null },
  });
  rerender({ snapshot: settled("1234", 2) });
  rerender({ snapshot: null });
  rerender({ snapshot: settled("1234", 1) });
  expect(numbers(result.current)).toEqual([1]);
});

it("换房间时历史清空", () => {
  const { result, rerender } = renderHook(({ snapshot }) => useCEERoundHistory(snapshot), {
    initialProps: { snapshot: settled("1234", 3) as CEERoomSnapshot | null },
  });
  rerender({ snapshot: settled("5678", 1) });
  expect(numbers(result.current)).toEqual([1]);
});
