import { ArrowDownWideNarrow, Check, ChevronDown, RotateCw } from "lucide-react"
import { DropdownMenu } from "radix-ui"

import { Button } from "@/components/ui/button"
import { isResourceSort, NODE_SORT_LABELS, type NodeSort } from "@/lib/node-sort"

const options = Object.keys(NODE_SORT_LABELS) as NodeSort[]
const itemClass = "flex min-h-9 cursor-default items-center justify-between gap-3 rounded-sm px-2.5 py-1.5 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"

export function NodeSortMenu({ value, onPick }: { value: NodeSort; onPick: (mode: NodeSort) => void }) {
  const label = NODE_SORT_LABELS[value]
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          variant={value === "default" ? "outline" : "secondary"}
          size="sm"
          className="tap tap-8 mt-1"
          data-node-sort
          aria-label={`节点排序，当前为${label}`}
        >
          <ArrowDownWideNarrow aria-hidden="true" className="text-muted-foreground" />
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
          <DropdownMenu.RadioGroup value={value}>
            {options.map((mode) => (
              <DropdownMenu.RadioItem key={mode} value={mode} onSelect={() => onPick(mode)} className={itemClass}>
                {NODE_SORT_LABELS[mode]}
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
