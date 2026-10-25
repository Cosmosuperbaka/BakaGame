import { FeedbackButton } from "@/components/account/AccountEntry";
import { SettingsEntry } from "@/components/settings/SettingsEntry";
import type { McpGameId } from "@/lib/McpConfig";

/** 房间顶栏右侧的反馈与设置：反馈紧挨设置，两者在三个游戏里保持同一位置。 */
export function RoomUtilityActions({ game }: { game: McpGameId }) {
  return (
    <div className="flex items-center gap-0.5">
      <FeedbackButton compact />
      <SettingsEntry game={game} />
    </div>
  );
}
