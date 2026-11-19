import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { animate, useReducedMotion } from "framer-motion";
import type { SendThrowState, ThrowHandle, ThrowHandoff } from "@/components/common/chat/ChatThrow";
import { chatThrow, jitterShape, stepJitterAnimation } from "@/lib/motion/Throw";
import type { ChatMessage } from "@bakagame/shared";

/**
 * 聊天发送：文字凝成胶囊掷出输入框（`thrown`），回显到达后自己那条气泡从胶囊手里接过去（`handoffId`）。
 * 成败只看 `onSendMessage` 的 promise：正常返回即已发出，回显晚到不算失败；失败把原文收回输入框。
 *
 * 胶囊、收回动画与回执都只有一份，所以发送带递增序号：只有仍是最新一条的失败才借用胶囊播收回动画，
 * 旧的一条失败时直接回写原文，并且输入框里已有新草稿就不覆盖。
 */
export function useChatSend({
  messages,
  myPlayerId,
  text,
  setText,
  inputRef,
  sendIconRef,
  onSendMessage,
  onError,
  onSent,
}: {
  messages: ChatMessage[];
  myPlayerId: string | undefined;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLInputElement | null>;
  /** 发送按钮里的图标：掷出时被反冲得逐格抖一下 */
  sendIconRef: RefObject<HTMLSpanElement | null>;
  onSendMessage: (text: string) => Promise<void> | void;
  onError?: (error: unknown) => void;
  /** 发出这一刻（清空输入框的同时）：提及候选在这时收起 */
  onSent?: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const [thrown, setThrown] = useState<SendThrowState | null>(null);
  const capsuleRef = useRef<ThrowHandle>(null);
  const [pendingEcho, setPendingEcho] = useState<{ baselineId: string | undefined } | null>(null);
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const handoff = useMemo<ThrowHandoff>(
    () => ({ capsule: capsuleRef, onTake: () => setThrown(null) }),
    []
  );
  // 收回动画承诺还给输入框的内容；落点写回，业务确认后撤掉。空串表示只是撤掉胶囊。
  const recalledTextRef = useRef("");
  const recallThrow = useCallback((sent: string) => {
    recalledTextRef.current = sent;
    setThrown((current) => current && { ...current, phase: "recall" });
  }, []);
  // 收回播完：胶囊撤掉，内容在这刻真正回到输入框；之后才到的回显按别人的消息那样弹出。
  const finishRecall = useCallback(() => {
    const recalled = recalledTextRef.current;
    setThrown(null);
    setPendingEcho(null);
    // 玩家已经接着打字就不覆盖他的输入
    setText((current) => (current ? current : recalled));
  }, [setText]);
  /** 一次发送的业务回执：成败只看 promise 有没有正常返回，动画时序不参与判定。 */
  const attemptRef = useRef<{ acked: boolean } | null>(null);
  // 发送序号：胶囊、收回动画与回执只有一份，前一条的失败不能去动后一条的胶囊。
  const sendSeqRef = useRef(0);

  // 本人最新一条消息：发送后它换了，就是这次发送的回显
  const lastMineId = useMemo(
    () => messages.findLast((message) => !message.system && message.playerId === myPlayerId)?.id,
    [messages, myPlayerId]
  );
  if (pendingEcho && lastMineId && lastMineId !== pendingEcho.baselineId) {
    setHandoffId(lastMineId);
    setPendingEcho(null);
  }

  // 胶囊悬停等回显。等不到时按业务回执分流：ACK 已到只是频道不回显，撤掉胶囊即可；
  // 没 ACK 才把内容收回输入框，别让玩家重打。
  const waitingKey = pendingEcho && thrown?.phase === "fly" ? thrown.key : null;
  const waitingText = thrown?.phase === "fly" ? thrown.text : "";
  useEffect(() => {
    if (waitingKey === null) return;
    const timer = window.setTimeout(
      () => recallThrow(attemptRef.current?.acked ? "" : waitingText),
      chatThrow.waitMs
    );
    return () => window.clearTimeout(timer);
  }, [waitingKey, waitingText, recallThrow]);

  /**
   * 记下发送这一刻的输入框位置，把文字掷出去等回显；发送按钮的图标被反冲得逐格抖一下。
   * 返回是否真的掷出：减弱动效或量不到输入框时没有胶囊可收回，失败要把内容直接写回输入框。
   */
  const startThrow = (sent: string) => {
    const input = inputRef.current;
    if (reducedMotion || !input) return false;
    const rect = input.getBoundingClientRect();
    setThrown({
      key: performance.now(),
      text: sent,
      anchor: { left: rect.left, top: rect.top, height: rect.height, maxWidth: rect.width },
      phase: "fly",
    });
    setPendingEcho({ baselineId: lastMineId });
    const icon = sendIconRef.current;
    if (icon) {
      const { keyframes, transition } = stepJitterAnimation(jitterShape.sendRecoil);
      void animate(icon, keyframes, transition);
    }
    return true;
  };

  /**
   * 发送成功只认 ACK：回显晚于等待窗口时内容不曾回到输入框，玩家看不到「没发出去」的假信号。
   * 万一先前已经收回，确认后就撤掉那一条原样文本，避免玩家照着它再发一遍；改过就留给他自己判断。
   */
  const confirmSent = (sent: string) => {
    if (recalledTextRef.current !== sent) return;
    recalledTextRef.current = "";
    setText((current) => (current === sent ? "" : current));
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const attempt = { acked: false };
    attemptRef.current = attempt;
    const seq = ++sendSeqRef.current;
    // 先清输入框再 await：乐观清除是防重复提交，内容找回来看下面的业务回执
    const flying = startThrow(trimmed);
    setText("");
    onSent?.();
    try {
      await onSendMessage(trimmed);
      attempt.acked = true;
      confirmSent(trimmed);
    } catch (error) {
      // 掷出过且胶囊还是这一条的，就交给收回动画，落点把内容写回；
      // 没有动画可走（或胶囊已经换成后一条）时立刻写回，输入框里已有新草稿就不覆盖
      if (flying && seq === sendSeqRef.current) recallThrow(trimmed);
      else setText((current) => (current ? current : trimmed));
      onError?.(error);
    }
  };

  return { thrown, capsuleRef, handoff, handoffId, finishRecall, handleSend };
}
