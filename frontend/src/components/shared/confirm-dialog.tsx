"use client";

/**
 * 通用二次确认弹窗（破坏性/不可逆操作共用）。
 *
 * 为什么单独抽出来：C36 这批要接的「税档软删」「定价改价」等操作都要求
 * **二次确认 + 错误如实透出**。各页面自己写一套 `window.confirm` 会有三个问题：
 *  · 无法显示后端返回的 403/409/422 原因（`window.confirm` 只有一句话）；
 *  · 无法在提交中禁用按钮 / 显示 pending，用户会重复点；
 *  · 测试里没法断言「弹窗里写了什么原因」。
 *
 * 这里只负责「确认 UI + 展示错误」，真正的请求逻辑留在调用方（便于各页复用同一张皮）。
 */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  pending = false,
  error = null,
  danger = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  pending?: boolean;
  /** 后端错误原文（403/409/422 的 detail/message），由调用方归一化后传进来 */
  error?: string | null;
  danger?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={danger ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "提交中…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
