import { ArrowDown, ArrowDownWideNarrow, ArrowUp, ArrowUpNarrowWide, Check, ChevronDown, RotateCw } from "lucide-react"
import { DropdownMenu } from "radix-ui"

import { Button } from "@/components/ui/button"
import { isResourceSort, NODE_SORT_LABELS, type NodeSort, type NodeSortChoice } from "@/lib/node-sort"

const options = Object.keys(NODE_SORT_LABELS) as NodeSort[]
const itemClass = "flex min-h-9 cursor-default items-center justify-between gap-3 rounded-sm px-2.5 py-1.5 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"

export function NodeSortMenu({ choice, onPick, onReverse }: {
  choice: NodeSortChoice
  onPick: (mode: NodeSort) => void
  onReverse: () => void
}) {
  const { mode: value, direction } = choice
  const ascending = direction === "asc"
  const label = value === "offline" && !ascending ? "在线优先" : NODE_SORT_LABELS[value]
  const current = value === "default" || value === "offline" ? label : `${label}，${ascending ? "升序" : "降序"}`
  const reverseText = value === "offline" ? (ascending ? "在线优先" : "离线优先") : (ascending ? "降序" : "升序")
  const SortIcon = value !== "default" && ascending ? ArrowUpNarrowWide : ArrowDownWideNarrow
  const ReverseIcon = ascending ? ArrowDown : ArrowUp
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          variant={value === "default" ? "outline" : "secondary"}
          size="sm"
          className="tap tap-8 mt-1"
          data-node-sort
          aria-label={`节点排序，当前为${current}`}
          title={current}
        >
          <SortIcon aria-hidden="true" className="text-muted-foreground" />
          <span>排序</span>
          {value !== "default" && <span className="hidden border-l border-border pl-1.5 sm:inline">{label}</span>}
          <ChevronDown aria-hidden="true" className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-label="节点排序"
          className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-44 overflow-y-auto rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
        >
          {value !== "default" && <>
            <DropdownMenu.Item className={itemClass} data-node-sort-direction onSelect={onReverse}>
              切换为{reverseText}
              <ReverseIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 border-t" />
          </>}
          <DropdownMenu.RadioGroup value={value}>
            {options.map((mode) => (
              <DropdownMenu.RadioItem key={mode} value={mode} onSelect={() => onPick(mode)} className={itemClass}>
                {mode === value ? label : NODE_SORT_LABELS[mode]}
                <DropdownMenu.ItemIndicator>
                  <Check aria-hidden="true" className="size-4 text-muted-foreground" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {isResourceSort(value) && <>
            <DropdownMenu.Separator className="my-1 border-t" />
            <DropdownMenu.Item className={itemClass} onSelect={() => onPick(value)}>
              重新排序
              <RotateCw aria-hidden="true" className="size-4 text-muted-foreground" />
            </DropdownMenu.Item>
          </>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
