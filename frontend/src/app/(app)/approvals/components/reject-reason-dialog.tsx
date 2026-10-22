"use client";

/**
 * 拒绝理由弹窗 —— **理由必填**（内核 422 `DECISION_REASON_REQUIRED`）。
 *
 * 为什么不用 ConfirmDialog：它不支持输入框，而拒绝的唯一有效内容是"要改什么"，
 * 没有理由的拒绝会把申请人卡死（内核因此强制 422）。前端做同一口径的预检 +
 * 把后端错误原文显示在弹窗里（403 自批 / 409 已处理都能看见原因）。
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const REASON_ID = "approval-reject-reason";

export function RejectReasonDialog({
  open,
  onOpenChange,
  title = "拒绝变更申请",
  description,
  pending = false,
  error = null,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  pending?: boolean;
  /** 后端错误原文（403/409/422），由调用方归一化后传入 */
  error?: string | null;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);

  // 关闭时清空草稿（在事件里重置，而不是 effect + setState）：下一条申请不带旧理由
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setReason("");
      setTouched(false);
    }
    onOpenChange(next);
  };

  const trimmed = reason.trim();
  const validation =
    touched && trimmed === ""
      ? "拒绝必须填写理由（申请人据此知道要改什么）"
      : null;
  const message = validation ?? error;

  const submit = () => {
    setTouched(true);
    if (trimmed === "") return;
    onSubmit(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor={REASON_ID}>
            拒绝理由 <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id={REASON_ID}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="说明哪里不对、希望申请人怎么改（会随通知发给申请人）"
            aria-invalid={message ? true : undefined}
            aria-describedby={message ? `${REASON_ID}-error` : undefined}
            disabled={pending}
            rows={4}
          />
          {message ? (
            <p
              id={`${REASON_ID}-error`}
              role="alert"
              className="text-sm text-destructive"
            >
              {message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={submit}
            disabled={pending}
          >
            {pending ? "提交中…" : "确认拒绝"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
