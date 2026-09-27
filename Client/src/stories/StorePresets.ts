import { useCCBStore, type CCBStore } from "@/stores/UseCCBStore";
import { useSonGuessrStore, type SonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useWhoIsFakerStore, type WhoIsFakerGameState } from "@/stores/UseWhoIsFakerStore";

// 连 Store 的组件在故事里只消费预置状态，不建立 WebSocket 连接。
// 每次都先回到初始状态再合并补丁：Store 是模块单例，不重置会把上一个故事的状态带进来。

type DataOf<T> = { [K in keyof T as T[K] extends (...args: never[]) => unknown ? never : K]: T[K] };

export function presetWhoIsFaker(patch: Partial<DataOf<WhoIsFakerGameState>> = {}) {
  useWhoIsFakerStore.setState({ ...useWhoIsFakerStore.getInitialState(), ...patch }, true);
}

export function presetSonGuessr(patch: Partial<DataOf<SonGuessrStore>> = {}) {
  useSonGuessrStore.setState({ ...useSonGuessrStore.getInitialState(), ...patch }, true);
}

export function presetCCB(patch: Partial<DataOf<CCBStore>> = {}) {
  useCCBStore.setState({ ...useCCBStore.getInitialState(), ...patch }, true);
}

/** 预览层在每个故事前调用，保证未显式预置的故事也从干净状态开始。 */
export function resetAllStores() {
  presetWhoIsFaker();
  presetSonGuessr();
  presetCCB();
}
