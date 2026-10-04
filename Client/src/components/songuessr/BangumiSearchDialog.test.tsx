import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { BangumiSearchDialog } from "./BangumiSearchDialog";
const props={ open:true, onOpenChange:vi.fn(), title:"搜索番剧", description:"选择番剧", actionLabel:"添加", onSelect:vi.fn() };
const initial=useSonGuessrStore.getState();
function deferred<T>() { let resolve!: (value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {resolve,reject,promise}; }
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.useRealTimers();useSonGuessrStore.setState(initial,true);});
it("在途请求清空输入后马上显示空态，晚响应不复活加载或结果",async()=>{
  const request=deferred<[]>();useSonGuessrStore.setState({ searchBangumi:vi.fn(()=>request.promise) });render(<BangumiSearchDialog {...props}/>);
  fireEvent.change(screen.getByPlaceholderText("输入番剧名称"),{target:{value:"测试"}});
  await act(async()=>vi.advanceTimersByTimeAsync(350));expect(screen.getByRole("status")).toHaveTextContent("正在查询 Bangumi");
  fireEvent.change(screen.getByPlaceholderText("输入番剧名称"),{target:{value:""}});
  expect(screen.getByText("搜索结果会显示在这里")).toBeInTheDocument();expect(screen.queryByRole("status")).toBeNull();
  await act(async()=>{request.resolve([]);await request.promise;});expect(screen.getByText("搜索结果会显示在这里")).toBeInTheDocument();
});
it("关闭再打开拥有新查询生命周期，旧请求不会污染新面板",async()=>{
  const request=deferred<[]>();useSonGuessrStore.setState({searchBangumi:vi.fn(()=>request.promise)});const h=render(<BangumiSearchDialog {...props}/>);
  fireEvent.change(screen.getByPlaceholderText("输入番剧名称"),{target:{value:"测试"}});await act(async()=>vi.advanceTimersByTimeAsync(350));
  h.rerender(<BangumiSearchDialog {...props} open={false}/>);h.rerender(<BangumiSearchDialog {...props}/>);
  expect(screen.getByPlaceholderText("输入番剧名称")).toHaveValue("");expect(screen.queryByRole("status")).toBeNull();
  await act(async()=>{request.resolve([]);await request.promise;});expect(screen.getByText("搜索结果会显示在这里")).toBeInTheDocument();
});
it("新查询先完成后旧查询失败，不替换结果或发过期错误",async()=>{
  const a=deferred<[]>();const b=deferred<[]>();const notice=vi.fn();const search=vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  useSonGuessrStore.setState({searchBangumi:search,setNotice:notice});render(<BangumiSearchDialog {...props}/>);
  fireEvent.change(screen.getByPlaceholderText("输入番剧名称"),{target:{value:"A"}});await act(async()=>vi.advanceTimersByTimeAsync(350));
  fireEvent.change(screen.getByPlaceholderText("输入番剧名称"),{target:{value:"B"}});await act(async()=>vi.advanceTimersByTimeAsync(350));
  await act(async()=>{b.resolve([]);await b.promise;});expect(screen.getByText("没有找到匹配番剧")).toBeInTheDocument();
  await act(async()=>{a.reject(new Error("旧请求失败"));});expect(notice).not.toHaveBeenCalled();expect(screen.getByText("没有找到匹配番剧")).toBeInTheDocument();
});
it("当前请求失败退出加载并显示可重试错误",async()=>{
  const notice=vi.fn();useSonGuessrStore.setState({searchBangumi:vi.fn().mockRejectedValue(new Error("搜索失败")),setNotice:notice});render(<BangumiSearchDialog {...props}/>);
  fireEvent.change(screen.getByPlaceholderText("输入番剧名称"),{target:{value:"失败"}});await act(async()=>vi.advanceTimersByTimeAsync(350));
  expect(screen.queryByRole("status")).toBeNull();expect(notice).toHaveBeenCalledExactlyOnceWith("搜索失败","error");
});
it("出题模式下选择番剧后展示关联歌曲列表并支持指定曲目出题",async()=>{
  const subject={ id:"sub-1", name:"Test Anime", nameCn:"测试动画" };
  const candidate={
    song:{ id:"song-99", title:"测试OP", artist:"歌手A", album:"单曲", duration:90 },
    track:{ title:"测试OP", artist:"歌手A", kind:"opening" as const },
  };
  const onSelect=vi.fn().mockResolvedValue(undefined);
  const onOpenChange=vi.fn();
  useSonGuessrStore.setState({
    searchBangumi:vi.fn().mockResolvedValue([subject]),
    resolveAnimeSongs:vi.fn().mockResolvedValue([candidate]),
  });
  render(<BangumiSearchDialog {...props} mode="submit" onSelect={onSelect} onOpenChange={onOpenChange} />);
  fireEvent.change(screen.getByPlaceholderText("输入番剧名称"),{target:{value:"测试"}});
  await act(async()=>vi.advanceTimersByTimeAsync(350));
  expect(screen.getByText("测试动画")).toBeInTheDocument();

  // 点击番剧，进入第二步
  fireEvent.click(screen.getByRole("button",{name:"添加"}));
  await act(async()=>Promise.resolve());

  expect(screen.getByText("选择目标关联曲")).toBeInTheDocument();
  expect(screen.getByText("测试OP")).toBeInTheDocument();
  expect(screen.getByText("OP")).toBeInTheDocument();
  expect(screen.getByText("歌手A · 单曲")).toBeInTheDocument();

  // 点击选择该歌曲出题
  fireEvent.click(screen.getByRole("button",{name:"添加"}));
  await act(async()=>Promise.resolve());

  expect(onSelect).toHaveBeenCalledWith(subject,"song-99");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
it("出题模式下支持更换番剧返回搜索结果",async()=>{
  const subject={ id:"sub-1", name:"Test Anime", nameCn:"测试动画" };
  useSonGuessrStore.setState({
    searchBangumi:vi.fn().mockResolvedValue([subject]),
    resolveAnimeSongs:vi.fn().mockResolvedValue([]),
  });
  render(<BangumiSearchDialog {...props} mode="submit" />);
  fireEvent.change(screen.getByPlaceholderText("输入番剧名称"),{target:{value:"测试"}});
  await act(async()=>vi.advanceTimersByTimeAsync(350));

  fireEvent.click(screen.getByRole("button",{name:"添加"}));
  await act(async()=>Promise.resolve());

  expect(screen.getByText("该番剧未匹配到可播放的关联歌曲")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"更换番剧"}));

  expect(screen.getByPlaceholderText("输入番剧名称")).toBeInTheDocument();
  expect(screen.getByText("测试动画")).toBeInTheDocument();
});

