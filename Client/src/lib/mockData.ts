import type {
  RoomSnapshot,
  PrivateState,
  GamePhase,
  PlayerRole,
  PlayerSide,
  PublicPlayerView,
  DescriptionRecord,
} from "@/types";

export type TestPerspective = "player" | "questioner" | "spectator";

export function createMockTestRoomState(
  phase: GamePhase = "waiting",
  perspective: TestPerspective = "player",
  role: PlayerRole = "civilian"
): { snapshot: RoomSnapshot; privateState: PrivateState | null } {
  const isQuestioner = perspective === "questioner";
  const isSpectator = perspective === "spectator";
  const wordsAssigned = !["waiting", "assigningQuestioner", "wordSubmission"].includes(phase);

  const meId = "player_me";
  const myName = isQuestioner ? "出题人 (你)" : isSpectator ? "旁观者 (你)" : "测试玩家 (你)";

  const players: PublicPlayerView[] = [
    {
      id: meId,
      name: myName,
      score: 5,
      membership: isSpectator ? "spectator" : "active",
      isReady: true,
      isHost: true,
      isBot: false,
      online: true,
      roundStatus: isQuestioner
        ? "questioner"
        : isSpectator
        ? "spectator"
        : phase === "waiting"
        ? "waiting"
        : "alive",
      revealedRole: phase === "gameOver" ? role : undefined,
    },
    {
      id: "player_b",
      name: "玩家B (平民)",
      score: 3,
      membership: "active",
      isReady: true,
      isHost: false,
      isBot: true,
      online: true,
      roundStatus: phase === "waiting" ? "waiting" : "alive",
      revealedRole: phase === "gameOver" ? "civilian" : undefined,
    },
    {
      id: "player_c",
      name: "玩家C (卧底)",
      score: 2,
      membership: "active",
      isReady: true,
      isHost: false,
      isBot: true,
      online: true,
      roundStatus: phase === "waiting" ? "waiting" : "alive",
      revealedRole: phase === "gameOver" ? "undercover" : undefined,
    },
    {
      id: "player_d",
      name: "玩家D (天使)",
      score: 4,
      membership: "active",
      isReady: true,
      isHost: false,
      isBot: true,
      online: true,
      roundStatus: phase === "waiting" ? "waiting" : "alive",
      revealedRole: phase === "gameOver" ? "angel" : undefined,
    },
    {
      id: "player_e",
      name: "玩家E (白板)",
      score: 1,
      membership: "active",
      isReady: true,
      isHost: false,
      isBot: true,
      online: true,
      roundStatus: phase === "waiting" ? "waiting" : "alive",
      revealedRole: phase === "gameOver" ? "blank" : undefined,
    },
  ];

  const mockDescriptions: DescriptionRecord[] = [
    {
      id: "desc_1",
      playerId: "player_b",
      playerName: "玩家B (平民)",
      text: "一种十分常见的水果，红红的，口感酸甜鲜美。",
      kind: "description",
      cycle: 1,
      createdAt: Date.now() - 30000,
    },
    {
      id: "desc_2",
      playerId: "player_c",
      playerName: "玩家C (卧底)",
      text: "外皮比较薄，可以直接切开吃或者拿去榨鲜果汁。",
      kind: "description",
      cycle: 1,
      createdAt: Date.now() - 20000,
    },
    {
      id: "desc_3",
      playerId: "player_d",
      playerName: "玩家D (天使)",
      text: "富含丰富的维生素，西餐里经常用来做成美味的甜品烤派。",
      kind: "description",
      cycle: 1,
      createdAt: Date.now() - 10000,
    },
  ];

  if (phase === "tieBreak") {
    mockDescriptions.push({
      id: "desc_pk_1",
      playerId: "player_b",
      playerName: "玩家B (平民)",
      text: "我是平民！我的词是红色的水果，大家千万别投错！",
      kind: "tieBreak",
      cycle: 1,
      createdAt: Date.now() - 5000,
    });
  }

  const snapshot: RoomSnapshot = {
    roomId: "Oblivionis",
    name: "离线测试房间",
    visibility: "public",
    allowSpectators: true,
    hasPassword: false,
    hostPlayerId: meId,
    testMode: true,
    settings: {
      roleConfig: {
        undercoverCount: 1,
        hasAngel: true,
        hasBlank: true,
      },
    },
    status: {
      started: phase !== "waiting",
      phase,
      day: phase === "waiting" ? 0 : 1,
      descriptionOrder: players
        .filter(
          (player) =>
            player.roundStatus === "alive" &&
            player.id !== (isQuestioner ? meId : "player_b"),
        )
        .map((player) => player.id),
      questionerPlayerId: isQuestioner ? meId : "player_b",
      blankGuessPlayerId: phase === "blankGuess" ? "player_e" : undefined,
      tieBreakStage: phase === "tieBreak" ? "description" : undefined,
      tieBreakIndex: phase === "tieBreak" ? 1 : undefined,
      tieBreakCandidateIds: phase === "tieBreak" ? ["player_b", "player_c"] : undefined,
    },
    roleLimits: {
      maxUndercoverCount: 2,
      canEnableAngel: true,
      canEnableBlank: true,
    },
    players,
    descriptions: phase === "waiting" || phase === "wordSubmission" ? [] : mockDescriptions,
    chat: [],
    summary:
      phase === "gameOver"
        ? {
            winner: "good",
            reason: "卧底已被全部投出，平民好人阵营获胜！",
            words: {
              pair: ["苹果", "香蕉"],
              civilianWord: "苹果",
              undercoverWord: "香蕉",
              blankHint: "常见水果",
            },
            awardedScores: [
              { playerId: meId, delta: 2 },
              { playerId: "player_b", delta: 2 },
              { playerId: "player_c", delta: 0 },
              { playerId: "player_d", delta: 2 },
              { playerId: "player_e", delta: 0 },
            ],
            revealedRoles: [
              ...(!isQuestioner && !isSpectator ? [{ playerId: meId, role }] : []),
              { playerId: "player_b", role: "civilian" },
              { playerId: "player_c", role: "undercover" },
              { playerId: "player_d", role: "angel" },
              { playerId: "player_e", role: "blank" },
            ],
            voteHistory: [
              {
                day: 1,
                tieBreak: false,
                votes: [
                  { voterId: meId, targetId: "player_c" },
                  { voterId: "player_b", targetId: "player_c" },
                  { voterId: "player_c", targetId: "player_b" },
                  { voterId: "player_d", targetId: "player_c" },
                  { voterId: "player_e", targetId: "player_b" },
                ],
              },
            ],
            descriptions: mockDescriptions,
            blankGuesses: [
              {
                playerId: "player_e",
                guessedWords: ["苹果", "鸭梨"],
                success: false,
                createdAt: Date.now() - 1000,
                reason: "eliminated",
              },
            ],
          }
        : undefined,
  };

  const questionerView =
    isQuestioner || isSpectator
      ? [
          { playerId: "player_b", role: "civilian" as PlayerRole, side: "good" as PlayerSide, alive: true },
          { playerId: "player_c", role: "undercover" as PlayerRole, side: "undercover" as PlayerSide, alive: true },
          { playerId: "player_d", role: "angel" as PlayerRole, side: "good" as PlayerSide, alive: true },
          { playerId: "player_e", role: "blank" as PlayerRole, side: "blank" as PlayerSide, alive: true },
        ]
      : undefined;

  const privateState: PrivateState = {
    playerId: meId,
    sessionToken: "mock_token",
    isQuestioner,
    role: isQuestioner || isSpectator ? undefined : role,
    word:
      !wordsAssigned || isQuestioner || isSpectator || role === "blank"
        ? undefined
        : role === "angel"
        ? undefined
        : "苹果",
    angelWordOptions:
      wordsAssigned && !isQuestioner && !isSpectator && role === "angel"
        ? ["苹果", "红富士"]
        : undefined,
    blankHint:
      wordsAssigned && !isQuestioner && !isSpectator && role === "blank"
        ? "常见水果"
        : undefined,
    canSubmitBlankGuess: role === "blank" && phase === "description",
    blankGuessUsed: false,
    nightActionSubmitted: false,
    questionerView,
  };

  return { snapshot, privateState };
}
