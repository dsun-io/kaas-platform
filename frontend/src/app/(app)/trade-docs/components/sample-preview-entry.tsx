"use client";

/**
 * 样板预览入口（2026-10-24，问题 6）—— 从"常驻大卡片"收成"按需打开的对话框"。
 *
 * 用户反馈：样板预览意义不大、不常用，却常驻页面顶部一大块（一个 900px 的 iframe），
 * 把真正的「开单」挤到第二屏。现在：
 *   · 入口只占一行（标题 + 一句说明 + 按钮），默认**收起**；
 *   · 点开在对话框里看，18 类单据的原型能力一个不少（`SamplePreview` 原样复用）；
 *   · 依旧**不写库、不产生业务记录**（固定样例数据，不依赖后端）。
 *
 * 为什么用 Dialog 而不是 `<details>`：样板预览是"看一版大图"的场景，
 * 页面内展开会把后面的台账再次推下去；对话框自带 Esc/遮罩关闭与焦点管理（键盘可达）。
 */
import { useState } from "react";
import { Eye } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { SamplePreview } from "./sample-preview";

export function SamplePreviewEntry() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-muted/30 px-4 py-2.5">
        <Eye aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">样板预览</span>
        <span className="text-xs text-muted-foreground">
          用固定样例数据看 18
          类单据的版式，不写库、不产生业务记录；需要校对版式时再打开。
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => setOpen(true)}
        >
          打开样板预览
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] w-full overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>样板预览（不需要真实单据）</DialogTitle>
            <DialogDescription>
              用固定样例数据渲染 18 类单据，用于校对版式、金额大写与日期写法。
              不写数据库、不产生业务记录。
            </DialogDescription>
          </DialogHeader>
          <SamplePreview />
        </DialogContent>
      </Dialog>
    </>
  );
}
