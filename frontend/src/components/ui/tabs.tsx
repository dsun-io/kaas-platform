"use client";

import * as React from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Tabs —— 全站统一的页内 tab 组件（收编此前 4 套手写实现）。
 *
 * 为什么要有这一层（docs/UI_REDESIGN 阶段 3 组件层）：
 * quotes/products/settings/intel 各写一套 tab，视觉与行为都不一致
 * （深链支持、状态保持、窄屏溢出各做各的）。新页面一律用本组件，
 * 旧页面在页面层重构时逐页替换。
 *
 * 两个硬语义（与 P14 产品工位的行为约束一致，组件层直接保证）：
 * - `keepMounted`（默认 true）：未选中的 panel **保持挂载**只是隐藏 ——
 *   tab 切走再切回，表单输入/选中状态不丢。要条件渲染须显式传 keepMounted={false}；
 * - 受控/非受控均可：深链 `?tab=` 场景用受控值 + 自己写 URL。
 */

const tabsListVariants = cva(
  "inline-flex items-center gap-1 rounded-lg p-0.5 outline-none",
  {
    variants: {
      variant: {
        // 下划线式 —— 报价/产品工位现行风格，默认
        line: "w-full justify-start overflow-x-auto rounded-none bg-transparent p-0",
        // 胶囊切换式 —— 设置页现行风格
        pills: "border bg-muted/40 w-full sm:w-fit",
      },
    },
    defaultVariants: { variant: "line" },
  },
);

const tabsTriggerVariants = cva(
  "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md text-sm font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        line: "border-b-2 border-transparent px-3 py-1.5 text-muted-foreground hover:text-foreground data-[selected]:border-primary data-[selected]:text-foreground",
        pills:
          "px-3 py-1.5 text-muted-foreground hover:text-foreground data-[selected]:bg-primary data-[selected]:text-primary-foreground",
      },
    },
    defaultVariants: { variant: "line" },
  },
);

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  );
}

function TabsList({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Tab> &
  VariantProps<typeof tabsTriggerVariants>) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(tabsTriggerVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsContent({
  className,
  keepMounted = true,
  value,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Panel>) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      data-value={value}
      keepMounted={keepMounted}
      className={cn("outline-none", className)}
      value={value}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
