import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useNumberDraft } from "./UseNumberDraft";

const setup = (value: number | undefined, optional = false) => {
  const onCommit = vi.fn();
  const hook = renderHook(
    (props: { value: number | undefined }) =>
      useNumberDraft({ value: props.value, minimum: 1, maximum: 10, optional, onCommit }),
    { initialProps: { value } }
  );
  return { onCommit, ...hook };
};

describe("useNumberDraft", () => {
  it("手动输入在提交时才夹到范围内、取整，没变化不重复提交", () => {
    const { result, onCommit } = setup(5);
    act(() => result.current.setDraft("99"));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => result.current.commitDraft());
    expect(onCommit).toHaveBeenCalledWith(10);
    expect(result.current.draft).toBe("10");
    act(() => result.current.setDraft("5.4"));
    act(() => result.current.commitDraft());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toBe("5");
  });

  it("留空或写了非数字退回当前值，不提交", () => {
    const { result, onCommit } = setup(5);
    act(() => result.current.setDraft(""));
    act(() => result.current.commitDraft());
    expect(result.current.draft).toBe("5");
    act(() => result.current.setDraft("abc"));
    act(() => result.current.commitDraft());
    expect(result.current.draft).toBe("5");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("可留空时，留空提交 undefined；本来就是空则不提交", () => {
    const { result, onCommit } = setup(3, true);
    act(() => result.current.setDraft(""));
    act(() => result.current.commitDraft());
    expect(onCommit).toHaveBeenCalledWith(undefined);
    const blank = setup(undefined, true);
    act(() => blank.result.current.commitDraft());
    expect(blank.onCommit).not.toHaveBeenCalled();
    expect(blank.result.current.draft).toBe("");
  });

  it("外部取值变了，草稿跟着重置", () => {
    const { result, rerender } = setup(5);
    act(() => result.current.setDraft("7"));
    rerender({ value: 8 });
    expect(result.current.draft).toBe("8");
  });

  it("按钮与方向键直接提交一个数，同样夹取", () => {
    const { result, onCommit } = setup(10);
    act(() => result.current.commit(11));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => result.current.commit(0));
    expect(onCommit).toHaveBeenCalledWith(1);
  });
});
