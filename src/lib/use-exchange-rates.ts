import { useEffect, useMemo, useSyncExternalStore } from "react"

import type { Node } from "./api.ts"
import { createFxStore } from "./exchange-rates.ts"
import { parseRateOverrides, recurringCurrency } from "./money.ts"

// 全站预算共用一份报价；节点实时刷新、分组切换和返回首页都不会各发一遍请求。
const store = createFxStore({
  storage: () => localStorage,
  canRefresh: () => document.visibilityState === "visible" && navigator.onLine !== false,
})
const inactive = () => () => undefined

/** 只有预算或月均费用排序需要自动折算时才订阅网络更新。 */
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

/** 概览与列表共用同一份报价和人工覆盖值。 */
export function useBillingRates(nodes: Node[], overrides: string, enabled: boolean) {
  const custom = useMemo(() => parseRateOverrides(overrides), [overrides])
  const needsFx = enabled && nodes.some((node) => {
    const code = recurringCurrency(node)
    return code !== null && code !== "CNY" && !Object.hasOwn(custom.rates, code)
  })
  const fx = useExchangeRates(needsFx)
  const rates = useMemo(() => ({ ...fx.snapshot.rates, ...custom.rates, CNY: 1 }), [fx.snapshot.rates, custom.rates])
  return { custom, needsFx, fx, rates }
}
