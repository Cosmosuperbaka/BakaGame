import { useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { SpectatorToggle } from "@/components/common/SpectatorToggle";
import { usePlayerRowKeys } from "@/hooks/UsePlayerRowKeys";
import { listContainer, listItem } from "@/lib/motion/Choreography";
import { DESCRIPTION_HEAD_TONES, descriptionCellShadeForPlayer } from "@/lib/DescriptionColumns";
import type { PlayerListHistory } from "./FakerSpeechHistory";
import { CompactNameCell, SpeechCell } from "./FakerSpeechCell";
import {
  PlayerRow,
  type PlayerMark,
  type PlayerMarks,
  type PlayerRowProps,
} from "./FakerPlayerRow";
import { cn } from "@/lib/Utils";
import {
  PLAYER_COLUMN_WIDTH,
  PLAYER_GROUP_TITLE_HEIGHT,
  PlayerGroupTitle,
  PlayerListLayout,
} from "@/components/common/PlayerStatusPill";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { buildKnownRoleMap } from "./FakerPlayerPresentation";
import { COMPACT_PLAYER_COLUMN_WIDTH, speechGridTemplate } from "./FakerPlayerListLayout";
import type {
  WhoIsFakerCommand,
  WhoIsFakerPayload,
  WhoIsFakerPhase,
  WhoIsFakerRole,
  WhoIsFakerPrivateState,
  PublicPlayerView,
  RoleConfig,
} from "@bakagame/shared";

export interface PlayerListProps {
  players: PublicPlayerView[];
  hostPlayerId: string;
  myPlayerId?: string;
  isHost: boolean;
  phase: WhoIsFakerPhase;
  allowSpectators: boolean;
  roleConfig: RoleConfig;
  privateState?: WhoIsFakerPrivateState | null;
  playerMarks: PlayerMarks;
  onMarkChange: (playerId: string, mark: PlayerMark) => void;
  /** 结算后公开的身份，叠加在出题人视角之上 */
  revealedRoles?: Map<string, WhoIsFakerRole>;
  /**
   * 展开发言历史时传入。
   * 发言单元格直接渲染进玩家行内，对齐由 DOM 结构保证，
   * 不依赖两侧各自复刻行高与间距。
   */
  history?: PlayerListHistory;
  /**
   * 移动端发言历史面板：玩家列收窄为只有头像与名字的固定列，横向滚动时贴住左缘，
   * 宽度让给发言列。身份标记与房主操作留在「玩家列表」面板里。
   */
  compact?: boolean;
}

export function FakerPlayerList(props: PlayerListProps) {
  const {
    players,
    myPlayerId,
    isHost,
    phase,
    allowSpectators,
    roleConfig,
    privateState,
    playerMarks,
    onMarkChange,
    revealedRoles,
    history,
    compact = false,
  } = props;
  const sendCommand = useWhoIsFakerStore((state) => state.sendCommand);
  const addToast = useWhoIsFakerStore((state) => state.addToast);
  const waitingPhase = phase === "waiting";
  const me = players.find((player) => player.id === myPlayerId);
  const isSpectator = me?.membership === "spectator";
  const canMarkPlayers =
    me?.membership === "active" &&
    !privateState?.isQuestioner &&
    !["waiting", "assigningQuestioner", "wordSubmission", "gameOver"].includes(phase);
  const showSpectatorToggle = waitingPhase && allowSpectators && Boolean(me);
  // 出题人视角、死亡公开身份和局后结算身份统一汇入同一份显示真值。
  const roleByPlayerId = buildKnownRoleMap(players, privateState, revealedRoles);
  const availableMarks: PlayerMark[] = [
    "unknown",
    "civilian",
    "undercover",
    ...(roleConfig.hasBlank ? (["blank"] as PlayerMark[]) : []),
    ...(roleConfig.hasAngel ? (["angel"] as PlayerMark[]) : []),
  ];

  const activePlayers = players.filter(
    (player) => player.membership === "active" && player.roundStatus !== "questioner"
  );
  const observers = players.filter(
    (player) => player.membership === "spectator" || player.roundStatus === "questioner"
  );
  // 换组后 key 随之变化，来回切换时不会复活还在退场的旧行（见 usePlayerRowKeys）。
  const rowKey = usePlayerRowKeys([
    ...activePlayers.map((player) => ({ id: player.id, group: "active" })),
    ...observers.map((player) => ({ id: player.id, group: "observer" })),
  ]);

  // 房主与旁观操作互相独立，不需要锁：发命令，失败落成错误提示
  const send = useCallback(
    async <TCommand extends WhoIsFakerCommand>(
      type: TCommand,
      payload: WhoIsFakerPayload<TCommand>
    ) => {
      try {
        await sendCommand(type, payload);
      } catch (error) {
        addToast((error as { message: string }).message, "error");
      }
    },
    [addToast, sendCommand]
  );
  const handleKick = (playerId: string) => void send("room.kick", { playerId });
  const handleTransferHost = (playerId: string) => void send("room.transferHost", { playerId });
  const handleSetSpectator = (spectator: boolean) =>
    void send("player.setSpectator", { spectator });

  /**
   * 渲染一行。展开发言历史时，玩家名与该行的发言单元格是同一个
   * flex 行的两部分，因此天然等高对齐。
   */
  const renderRow = (
    player: PublicPlayerView,
    hideSpectatorStatus: boolean,
    rowIndex: number,
    options?: { readOnly?: boolean }
  ) => {
    const rowProps: PlayerRowProps = {
      player,
      myPlayerId,
      isHostViewer: isHost,
      waitingPhase,
      hideSpectatorStatus,
      actualRole: roleByPlayerId.get(player.id),
      mark: playerMarks[player.id] ?? "unknown",
      canMark: Boolean(
        !options?.readOnly &&
        canMarkPlayers &&
        player.membership === "active" &&
        player.roundStatus !== "questioner"
      ),
      availableMarks,
      onMarkChange,
      onKick: handleKick,
      onTransferHost: handleTransferHost,
    };

    // 未展开历史时 PlayerRow 自带进出场动画，直接返回。
    if (!history) return <PlayerRow key={rowKey(player.id)} {...rowProps} />;

    // 展开后由外层承担进出场，行内首列去掉自身动画以免双重变换。
    // 列轨道继承自外层 grid，保证同一列在所有行上等宽。
    return (
      <motion.div
        key={rowKey(player.id)}
        variants={listItem}
        initial="initial"
        animate="animate"
        exit="exit"
        layout="position"
        className="col-span-full grid grid-cols-subgrid items-stretch"
      >
        {compact ? (
          <CompactNameCell player={player} me={player.id === myPlayerId} />
        ) : (
          <div className="px-2">
            <PlayerRow {...rowProps} embedded />
          </div>
        )}
        {history.columns.map((column) => (
          <SpeechCell
            key={column.key}
            description={history.byPlayer.get(player.id)?.get(column.key)}
            order={
              history.playerOrder?.get(player.id)?.get(column.key) ??
              history.byPlayer.get(player.id)?.get(column.key)?.order
            }
            expected={column.expectedPlayerIds.has(player.id)}
            submitted={
              column.key === history.submittedColumnKey &&
              Boolean(history.submittedPlayerIds?.has(player.id))
            }
            shade={descriptionCellShadeForPlayer(player, rowIndex, column.index)}
          />
        ))}
      </motion.div>
    );
  };

  /** 分组标题行。展开历史时右侧续接列标题，与首列同高。 */
  const renderGroupTitle = (label: string, count: number, withRule: boolean) => {
    const title = <PlayerGroupTitle label={label} count={count} withRule={withRule} />;
    if (!history) return title;
    return (
      <div className="col-span-full grid grid-cols-subgrid items-stretch">
        <div className={compact ? "sticky left-0 z-panel border-r bg-panel px-2" : "px-2"}>
          {title}
        </div>
        {history.columns.map((column) => (
          <div
            key={column.key}
            className={cn(
              "flex items-center whitespace-nowrap px-4 text-2xs font-semibold",
              withRule && "mt-3",
              DESCRIPTION_HEAD_TONES[column.tone]
            )}
            style={{ height: PLAYER_GROUP_TITLE_HEIGHT }}
          >
            {/* 列标题只在第一组显示，第二组留空避免重复 */}
            {withRule ? null : column.label}
          </div>
        ))}
      </div>
    );
  };

  const departed = history?.departedPlayers ?? [];
  // 展开历史时分组容器只负责纵向排布，列轨道由最外层 grid 统一持有。
  const groupClass = history
    ? "col-span-full grid grid-cols-subgrid gap-y-px"
    : "flex flex-col gap-px";
  // 斑马纹按整张表连续计数，跨分组也不会在交界处出现两行同色。
  const observerRowOffset = activePlayers.length;
  const departedRowOffset = observerRowOffset + observers.length;

  const body = (
    <div
      className={cn(
        "relative py-2",
        history ? "grid min-h-full w-max min-w-full content-start" : "flex flex-col"
      )}
      style={
        history
          ? {
              gridTemplateColumns: speechGridTemplate(
                history.columns.length,
                compact ? COMPACT_PLAYER_COLUMN_WIDTH : PLAYER_COLUMN_WIDTH
              ),
            }
          : undefined
      }
    >
      {/* 玩家列与发言列的分界线。整列贯穿到底，不随最后一行结束，
          否则行间距与列表末尾的空白处会把线断开。
          位置必须与行内首列取同一个宽度值，用 rem 而非像素常量，
          否则 120% 全局字号会让线落进玩家列内部。 */}
      {/* 紧凑模式的玩家列贴住左缘，分界线改由列自身的右边框承担，否则横滚时线会留在原地。 */}
      {history && !compact ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-px bg-border"
          style={{ left: PLAYER_COLUMN_WIDTH }}
        />
      ) : null}
      {renderGroupTitle("玩家", activePlayers.length, false)}
      <motion.div
        className={groupClass}
        variants={listContainer(activePlayers.length)}
        initial={false}
        animate="animate"
      >
        <AnimatePresence initial={false} mode="popLayout">
          {activePlayers.map((player, index) => renderRow(player, false, index))}
        </AnimatePresence>
      </motion.div>

      {showSpectatorToggle && isSpectator ? (
        <SpectatorToggle spectator={false} onToggle={handleSetSpectator} />
      ) : null}

      {observers.length > 0 || (showSpectatorToggle && !isSpectator) ? (
        <>
          {renderGroupTitle("旁观", observers.length, true)}
          <motion.div
            className={groupClass}
            variants={listContainer(observers.length)}
            initial={false}
            animate="animate"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {observers.map((player, index) => renderRow(player, true, observerRowOffset + index))}
            </AnimatePresence>
          </motion.div>
          {showSpectatorToggle && !isSpectator ? (
            <SpectatorToggle spectator onToggle={handleSetSpectator} />
          ) : null}
        </>
      ) : null}

      {/* 已离场但本局有发言记录的玩家，只读展示 */}
      {departed.length > 0 ? (
        <>
          {renderGroupTitle("已离场", departed.length, true)}
          <div className={groupClass}>
            {departed.map((player, index) =>
              renderRow(player, true, departedRowOffset + index, { readOnly: true })
            )}
          </div>
        </>
      ) : null}
    </div>
  );

  // 展开后玩家列和发言列必须共享同一个双向滚动容器，才能保持行对齐；
  // 外层面板只负责裁切动画范围，不会替这里提供滚动。
  if (history) {
    return (
      <div
        data-testid="player-history-scroll"
        className="scrollbar-hidden h-full min-h-0 overflow-auto"
      >
        {body}
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      <PlayerListLayout>
        <div className="px-2">{body}</div>
      </PlayerListLayout>
    </ScrollArea>
  );
}
