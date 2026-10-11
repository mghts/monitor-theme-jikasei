import { useEffect, useSyncExternalStore } from "react"

import { createFxStore } from "./exchange-rates.ts"

// 全站预算共用一份报价；节点实时刷新、分组切换和返回首页都不会各发一遍请求。
const store = createFxStore({
  storage: () => localStorage,
  canRefresh: () => document.visibilityState === "visible" && navigator.onLine !== false,
})
const inactive = () => () => undefined

/** 只有显示预算且需要外币自动折算时才订阅网络更新。 */
export function useExchangeRates(enabled: boolean) {
  const state = useSyncExternalStore(enabled ? store.subscribe : inactive, store.getSnapshot, store.getSnapshot)
  useEffect(() => {
    if (!enabled) return
    const visible = () => {
      if (document.visibilityState === "visible") void store.refresh()
    }
    const online = () => { void store.refresh(true) }
    document.addEventListener("visibilitychange", visible)
    window.addEventListener("online", online)
    return () => {
      document.removeEventListener("visibilitychange", visible)
      window.removeEventListener("online", online)
    }
  }, [enabled])
  return state
}
