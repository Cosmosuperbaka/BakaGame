import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAccountStore } from "@/stores/UseAccountStore";
import { RoomUtilityActions } from "./RoomUtilityActions";

describe("RoomUtilityActions", () => {
  it("房间顶栏的反馈紧挨设置，顺序固定", () => {
    useAccountStore.setState({ status: "guest", profile: null, unreadFeedback: 0 });
    render(<RoomUtilityActions game="faker" />);

    const feedback = screen.getByRole("button", { name: "反馈" });
    const settings = screen.getByRole("button", { name: "设置" });
    const row = settings.parentElement as HTMLElement;
    expect(feedback.parentElement).toBe(row);
    expect(Array.from(row.children).indexOf(feedback)).toBeLessThan(
      Array.from(row.children).indexOf(settings)
    );
  });
});
