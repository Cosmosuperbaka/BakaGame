import { expect, test } from "bun:test";
import { redactPrivateState } from "../src/application/McpSeatRegistry";

test("接管座位的人类查看器保留渲染控件的能力位，但拿不到词语、答案与猜测内容", () => {
  const faker = redactPrivateState("faker", {
    playerId: "p1",
    sessionToken: "token",
    role: "undercover",
    word: "苹果",
    isQuestioner: true,
    canSubmitBlankGuess: true,
    globalWords: { civilianWord: "苹果", undercoverWord: "梨" },
    privilegedActionPreview: { votes: [{ voterId: "p2", targetId: "p1" }] },
  });
  expect(faker).toMatchObject({
    role: "undercover",
    isQuestioner: true,
    canSubmitBlankGuess: true,
    mcpControlled: true,
  });
  expect(faker).not.toHaveProperty("word");
  expect(faker).not.toHaveProperty("globalWords");
  expect(faker).not.toHaveProperty("privilegedActionPreview");

  const song = redactPrivateState("song", {
    playerId: "p1",
    sessionToken: "token",
    isSubmitter: true,
    canSubmitSong: true,
    canGuess: false,
    submitterCandidateIds: ["p1"],
    submittedSong: { id: "song-1", title: "秘密答案" },
    visibleAttempts: [{ id: "a1" }],
  });
  expect(song).toMatchObject({
    isSubmitter: true,
    canSubmitSong: true,
    submitterCandidateIds: ["p1"],
  });
  expect(song).not.toHaveProperty("submittedSong");
  expect(song.visibleAttempts).toEqual([]);

  const cee = redactPrivateState("cee", {
    playerId: "p1",
    sessionToken: "token",
    canSetAnswer: true,
    setterCandidateIds: ["p1"],
    answer: { id: 9, name: "秘密角色" },
    hints: ["提示"],
    guesses: [{ character: { id: 9 } }],
  });
  expect(cee).toMatchObject({ canSetAnswer: true, setterCandidateIds: ["p1"] });
  expect(cee.answer).toBeNull();
  expect(cee.hints).toEqual([]);
  expect(cee.guesses).toEqual([]);
});
