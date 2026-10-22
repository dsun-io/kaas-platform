"use client";

/**
 * 「发送测试邮件」收件人弹窗。
 *
 * 为什么替换掉 `window.prompt`（P0-B1）：
 *  · prompt 只有一句输入，没法显示校验/失败原因，也不能在提交中禁用按钮；
 *  · 测试邮件是**真实外发**（会消耗发信额度），重复点会重复发。
 * 这里只负责「收件人输入 + 提交中禁用 + 错误如实展示」，请求本身留在这一个组件里，
 * 避免页面再散落一套 pending 状态。
 */
import { useRef, useState } from "react";
import { toast } from "sonner";

import apiClient from "@/lib/api/client";
import { normalizeApiError } from "@/lib/api/api-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface TestMailboxTarget {
  id: number;
  email: string;
}

export function TestMailboxDialog({
  mailbox,
  onOpenChange,
}: {
  mailbox: TestMailboxTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 同一 tick 连点两次时 `sending` 还没随重渲染生效，必须用 ref 挡住第二次请求。
  const sendingRef = useRef(false);

  const handleOpenChange = (next: boolean) => {
    if (sendingRef.current) return; // 提交中不允许关闭（避免"关掉了但还在发"）
    if (!next) {
      setTo("");
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    if (!mailbox || sendingRef.current) return;
    const target = to.trim();
    if (!target) {
      setError("请填写收件人邮箱");
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const { data } = await apiClient.post<{
        status: string;
        error?: string;
      }>(
        `/outreach/mailboxes/${mailbox.id}/test?to=${encodeURIComponent(target)}`,
      );
      if (data.status === "sent") {
        toast.success("测试邮件已发送");
        setTo("");
        setError(null);
        onOpenChange(false);
      } else {
        setError(`发送失败：${data.error ?? "未知原因"}`);
      }
    } catch (err) {
      setError(normalizeApiError(err).message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <Dialog open={mailbox !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>发送测试邮件</DialogTitle>
          <DialogDescription>
            从「{mailbox?.email ?? ""}
            」发出。测试邮件是真实外发，请确认收件人后再发送。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <label
            htmlFor="test-mailbox-to"
            className="text-xs text-muted-foreground"
          >
            收件人邮箱
          </label>
          <Input
            id="test-mailbox-to"
            type="email"
            placeholder="name@example.com"
            value={to}
            disabled={sending}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </div>

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
            onClick={() => handleOpenChange(false)}
            disabled={sending}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={sending || to.trim() === ""}
          >
            {sending ? "发送中…" : "发送测试"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
