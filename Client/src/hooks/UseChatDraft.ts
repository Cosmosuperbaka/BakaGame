import { createContext, useContext, useState, type Dispatch, type SetStateAction } from "react";

/** 房间外壳持有的聊天草稿：聊天在桌面栏与窄屏抽屉之间切换挂载时，没发出去的文字不丢。 */
export type ChatDraft = [string, Dispatch<SetStateAction<string>>];

export const ChatDraftContext = createContext<ChatDraft | null>(null);

/** 房间外壳里创建草稿，经 `ChatDraftContext.Provider` 提供给里面的聊天面板。 */
export function useChatDraftSource(): ChatDraft {
  return useState("");
}

/** 聊天面板的输入文字：在房间外壳里读外壳持有的草稿，单独使用（故事、测试）时用自己的状态。 */
export function useChatDraft(): ChatDraft {
  const shared = useContext(ChatDraftContext);
  const own = useState("");
  return shared ?? own;
}
