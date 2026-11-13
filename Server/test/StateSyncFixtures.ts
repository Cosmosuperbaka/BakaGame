import { StateSyncEncoder, type StateSyncEncodeOptions } from "../src/transport/StateSync";

/** 状态帧在线上是文本，其余事件透传对象：断言字段的用例统一还原成对象。 */
export const decodeFrame = (frame: unknown): unknown =>
  typeof frame === "string" ? JSON.parse(frame) : frame;

/** 与生产编码器同一份实现，只是把产出的文本帧还原成对象，便于逐字段断言。 */
export class DecodingStateSyncEncoder extends StateSyncEncoder {
  override encode(payload: unknown, options: StateSyncEncodeOptions = {}): unknown[] {
    return super.encode(payload, options).map(decodeFrame);
  }
}

/** 一帧在线上的字节数：文本帧按文本计，对象帧按序列化后计。 */
export const wireBytes = (frame: unknown): number =>
  Buffer.byteLength(typeof frame === "string" ? frame : JSON.stringify(frame), "utf8");
