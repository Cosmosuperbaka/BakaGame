import { FeedbackButton } from "@/components/account/AccountEntry";
import { SettingsEntry } from "@/components/settings/SettingsEntry";

/** 房间顶栏右侧的反馈与设置：反馈紧挨设置，两者在三个游戏里保持同一位置。 */
export function RoomUtilityActions({ agentsBlocked }: { agentsBlocked: boolean }) {
  return (
    <div className="flex items-center gap-0.5">
      <FeedbackButton compact />
      <SettingsEntry agentsBlocked={agentsBlocked} />
    </div>
  );
}
