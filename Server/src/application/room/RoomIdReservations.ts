import { AppError } from "../../domain/Errors";

export interface RoomIdTakenError {
  code: string;
  message: string;
}

/** 房号已被使用时的错误。 */
export const ROOM_ID_TAKEN: RoomIdTakenError = { code: "ROOM_EXISTS", message: "该房间号已被使用" };

/**
 * 建房期间的房号占用。
 *
 * 建私密房要跨一次 await 算口令摘要。过去三款都是「先把半成品房间放进房间表、再算摘要」，
 * 窗口内任何读房间表的路径都能看到一间没有摘要的私密房。占号与「房间可见」必须分开：
 * 同步 `hold` 占号 → 构造房间但不登记 → await 摘要 → 复核 → 一次性登记进房间表 → 释放占号。
 * 占号期间同号的第二次建房被拒，而入房、大厅、巡检都看不到这间房。
 */
export class RoomIdReservations {
  /** 房号 → 本次占用的凭据：释放时只认自己那一份，旧的释放函数不会误放后来者。 */
  private readonly held = new Map<string, symbol>();
  private readonly takenError: RoomIdTakenError;

  constructor(
    options: {
      /**
       * TODO(行为统一)：卧底今天回 `ROOM_ALREADY_EXISTS`，猜歌与 CEE 回 `ROOM_EXISTS`。
       * 接入时卧底传自己的现值以保持零变化；三款统一错误码后删掉本参数，只留缺省值。
       */
      takenError?: RoomIdTakenError;
    } = {}
  ) {
    this.takenError = options.takenError ?? ROOM_ID_TAKEN;
  }

  has(roomId: string): boolean {
    return this.held.has(roomId);
  }

  /**
   * 同步占号。`isTaken` 回答「已有房间，或被别的目录占用」（CEE 的原版房号目录）。
   * 已存在或已被占抛房号占用错误；返回的释放函数幂等，调用方放进 `finally`。
   */
  hold(roomId: string, isTaken: (roomId: string) => boolean): () => void {
    if (this.held.has(roomId) || isTaken(roomId)) {
      throw new AppError(this.takenError.code, this.takenError.message);
    }
    const ticket = Symbol(roomId);
    this.held.set(roomId, ticket);
    return () => {
      if (this.held.get(roomId) === ticket) this.held.delete(roomId);
    };
  }
}
