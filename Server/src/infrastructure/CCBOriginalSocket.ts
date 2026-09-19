import { io } from 'socket.io-client';
import { AppError } from '../domain/Errors';
import { originalObject, originalString } from './CCBOriginalProtocol';

export interface CCBOriginalSocket {
  readonly id: string | undefined;
  readonly connected: boolean;
  on(event: string, listener: (payload?: unknown) => void): void;
  off(event: string, listener: (payload?: unknown) => void): void;
  emit(event: string, payload: unknown, ack?: (payload: unknown) => void): void;
  connect(): void;
  disconnect(): void;
  removeAllListeners(): void;
}
export type CCBOriginalSocketFactory = (url: string) => CCBOriginalSocket;
export const createCCBOriginalSocket: CCBOriginalSocketFactory = url => io(url, {
  path: '/api/ws', transports: ['websocket'], autoConnect: false, reconnection: false, forceNew: true,
});

export function originalRequest(socket: CCBOriginalSocket, event: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.off('disconnect', disconnected);
      if (error) reject(error); else resolve(result || {});
    };
    const disconnected = () => finish(new AppError('CCB_ORIGINAL_DISCONNECTED', '原版连接已中断，请重新加入房间'));
    const timer = setTimeout(() => finish(new AppError('CCB_ORIGINAL_TIMEOUT', '原版服务器未确认操作，请同步房间状态后重试')), 8000);
    socket.on('disconnect', disconnected);
    socket.emit(event, payload, response => {
      try {
        const result = originalObject(response);
        finish(result.ok === false ? new AppError('CCB_ORIGINAL_REJECTED', originalString(result.message, '原版服务器拒绝了操作')) : undefined, result);
      } catch (error) { finish(error instanceof Error ? error : new Error('原版响应无效')); }
    });
  });
}

export function originalConfirmedEvent(socket: CCBOriginalSocket, event: string, predicate: (payload: unknown) => boolean,
  send: () => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, payload?: unknown) => {
      clearTimeout(timer);
      socket.off(event, received);
      socket.off('error', failed);
      socket.off('connect_error', failed);
      socket.off('disconnect', disconnected);
      if (error) reject(error); else resolve(payload);
    };
    const received = (payload?: unknown) => {
      try { if (predicate(payload)) finish(undefined, payload); }
      catch { finish(new AppError('CCB_ORIGINAL_PROTOCOL', '原版服务器返回了无效状态')); }
    };
    const failed = () => finish(new AppError('CCB_ORIGINAL_REJECTED', '原版服务器未接受请求，请检查房间或玩家名称'));
    const disconnected = () => finish(new AppError('CCB_ORIGINAL_DISCONNECTED', '原版连接已中断'));
    const timer = setTimeout(() => finish(new AppError('CCB_ORIGINAL_TIMEOUT', '原版服务器未确认操作')), 8000);
    socket.on(event, received);
    socket.on('error', failed);
    socket.on('connect_error', failed);
    socket.on('disconnect', disconnected);
    send();
  });
}
