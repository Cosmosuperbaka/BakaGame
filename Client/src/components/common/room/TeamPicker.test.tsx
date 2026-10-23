import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { PlayerAccount } from "@bakagame/shared";
import { TeamPicker } from "./TeamPicker";

type Member = { id: string; name: string; team: number | null; account?: PlayerAccount };

const account = (userId: string, image: string | null): PlayerAccount => ({ userId, image });

function renderPicker(players: Member[], selfId = "p1") {
  return render(
    <TooltipProvider>
      <TeamPicker
        players={players}
        selfId={selfId}
        switching={false}
        hint="同队共享次数与猜测"
        onPick={vi.fn()}
      />
    </TooltipProvider>
  );
}

/**
 * 某一格（整个 label）。
 *
 * `getByRole("radio")` 命中的是格子里那个 sr-only 的 `<input>`，它没有子节点；
 * 人数与头像都在同级的 label 上，所以要回到 label 再取。
 */
function cellOf(teamLabel: string): HTMLElement {
  const input = screen.getByRole("radio", { name: new RegExp(`^${teamLabel}，`) });
  return (input.closest("label") ?? input) as HTMLElement;
}
const avatarTiles = (cell: HTMLElement) => [...cell.querySelectorAll(".h-6.w-6")];

describe("TeamPicker 成员头像", () => {
  it("登录玩家显示账号头像，游客退回昵称首字", () => {
    renderPicker([
      { id: "p1", name: "小明", team: 1, account: account("u1", "/api/account/avatar/u1?v=1") },
      { id: "p2", name: "游客甲", team: 1 },
    ]);

    const cell = cellOf("1 队");
    const tiles = avatarTiles(cell);
    expect(tiles).toHaveLength(2);
    // 登录的那格是 <img>，游客那格仍是首字方块。
    expect(tiles.filter((tile) => tile.tagName === "IMG")).toHaveLength(1);
    expect(cell.textContent).toContain("游");
  });

  it("头像地址为空时不渲染 img，仍走首字", () => {
    renderPicker([{ id: "p1", name: "小红", team: 2, account: account("u2", null) }]);

    const cell = cellOf("2 队");
    expect(avatarTiles(cell).some((tile) => tile.tagName === "IMG")).toBe(false);
    expect(cell.textContent).toContain("小");
  });

  it("超过四个成员时只叠四个，其余折成 +N", () => {
    const many: Member[] = Array.from({ length: 6 }, (_, index) => ({
      id: `p${index}`,
      name: `玩${index}`,
      team: 3,
    }));
    renderPicker(many, "p0");

    const cell = cellOf("3 队");
    expect(avatarTiles(cell)).toHaveLength(4);
    expect(cell.textContent).toContain("+2");
  });
});
