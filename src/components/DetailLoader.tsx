import { lazy, type ComponentProps, type ComponentType } from "react"

import { Button } from "@/components/ui/button"

type DetailProps = ComponentProps<typeof import("@/components/NodeDetail").NodeDetail> & {
  onLoadFailureBack: () => void
}
type DetailModule = { default: ComponentType<DetailProps> }

function DetailLoadFailure({ embedded, onLoadFailureBack }: DetailProps) {
  return (
    <div data-detail-load-error role="alert" className="space-y-3 py-8 text-center text-sm">
      <p className="text-muted-foreground">详情加载失败，请刷新页面后重试。</p>
      <div className="flex justify-center gap-2">
        <Button data-detail-reload size="sm" onClick={() => location.reload()}>刷新页面</Button>
        <Button data-detail-back variant="outline" size="sm" onClick={onLoadFailureBack}>{embedded ? "收起展开" : "返回列表"}</Button>
      </div>
    </div>
  )
}

// 首页预热、整页详情与紧凑展开共用一次加载。只处理动态 import 失败；不捕获详情渲染错误。
// 浏览器可能缓存失败的模块请求，同页再次 import 无法可靠恢复，因此失败入口提供整页刷新。
let request: Promise<DetailModule> | undefined
function loadDetail(): Promise<DetailModule> {
  return request ??= import("@/components/NodeDetail")
    .then((module) => ({ default: module.NodeDetail }))
    .catch(() => ({ default: DetailLoadFailure }))
}

export function warmNodeDetail(): void {
  // loadDetail 将 import rejection 转为失败组件，预热不会产生未处理的 Promise rejection。
  void loadDetail()
}

export const DetailLoader = lazy(loadDetail)
