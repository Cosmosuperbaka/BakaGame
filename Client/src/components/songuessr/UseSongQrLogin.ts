import { useEffect, useState, useSyncExternalStore } from "react";
import { SongQrLogin, type QrLoginDeps, type QrLoginSnapshot } from "./SongQrLogin";

/**
 * 扫码登录状态机的 React 接口：状态机只建一次，回调每次渲染后换成最新的，
 * 因此在途请求回来时读到的是玩家此刻的偏好（例如刚拨动的「保存登录状态」）。
 * 卸载时作废在途请求。
 */
export function useSongQrLogin(deps: QrLoginDeps): QrLoginSnapshot & { login: SongQrLogin } {
  const [login] = useState(() => new SongQrLogin(deps));
  useEffect(() => {
    login.updateDeps(deps);
  });
  useEffect(() => () => login.dispose(), [login]);
  const snapshot = useSyncExternalStore(login.subscribe, login.getSnapshot);
  return { ...snapshot, login };
}
