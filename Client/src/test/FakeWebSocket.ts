/** 能精确控制生命周期的假连接：close() 只进入关闭中，收尾事件由测试决定何时到达。 */
export class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSING;
  }

  /** 服务端接受升级。 */
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** 关闭收尾事件到达。 */
  finishClose() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  receive(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

export const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
};
