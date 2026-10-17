"use client";

import * as React from "react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * DetailDrawer —— 统一的「详情抽屉」模式。
 *
 * 收编三种并存的详情呈现：customers 在列表下方渲染整卡、events 用右侧 Sheet、
 * trade-docs 用预览区。新页面一律右侧抽屉；旧的随页面层重构逐页替换。
 * 基于 ui/sheet，静态导出兼容（无 portal 依赖问题）。
 */

interface DetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  widthClassName?: string;
}

function DetailDrawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  widthClassName = "sm:max-w-xl",
}: DetailDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className={`flex w-full flex-col gap-0 overflow-hidden p-0 ${widthClassName}`}
      >
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-base">{title}</SheetTitle>
          {description ? (
            <SheetDescription>{description}</SheetDescription>
          ) : null}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="border-t px-5 py-3">{footer}</div> : null}
      </SheetContent>
    </Sheet>
  );
}

export { DetailDrawer };
