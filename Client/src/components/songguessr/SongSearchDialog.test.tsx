import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSongGuessrStore } from "@/stores/UseSongGuessrStore";
import { SongSearchDialog } from "./SongSearchDialog";

describe("SongSearchDialog", () => {
  let searchMusic: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    searchMusic = vi.fn();
    useSongGuessrStore.setState({
      searchMusic,
      setNotice: vi.fn(),
    });
  });

  it("在操作区内嵌显示搜索结果并提交所选歌曲", async () => {
    searchMusic.mockResolvedValue([{
      id: "song-1",
      title: "测试歌曲",
      artist: "测试歌手",
      album: "测试专辑",
    }]);
    const onOpenChange = vi.fn();
    const onSelect = vi.fn().mockResolvedValue(undefined);

    render(
      <SongSearchDialog
        open
        onOpenChange={onOpenChange}
        title="提交你的猜测"
        description="搜索说明"
        actionLabel="猜这首"
        onSelect={onSelect}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("输入歌名、歌手或专辑"), {
      target: { value: "测试" },
    });

    expect(await screen.findByText("测试歌曲")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "猜这首" }));
    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "song-1" }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
