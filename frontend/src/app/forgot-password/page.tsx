"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AUTH_INPUT_CLASS,
  AuthAlert,
  AuthShell,
} from "@/components/auth/auth-shell";
import { Loader2, MailCheck } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setError("");
    setSubmitting(true);
    try {
      // 后端无论邮箱是否存在都返回统一 {ok:true} —— 前端据此统一提示，不泄露存在性
      await apiClient.post("/auth/forgot-password", { email: email.trim() });
      setSent(true);
    } catch {
      setError("发送失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <h2 className="text-xl font-semibold tracking-tight">忘记密码</h2>
      <p className="mt-1 text-sm text-muted-foreground">通过注册邮箱重置密码</p>

      {sent ? (
        <div className="mt-10 flex flex-col items-center text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <MailCheck className="size-8 text-primary" />
          </div>
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
            如果该邮箱已注册，重置链接已发送。
            <br />
            请检查收件箱（含垃圾邮件），链接 30 分钟内有效。
          </p>
          <Link
            href="/login"
            className="mt-6 text-sm font-medium text-primary hover:underline"
          >
            返回登录
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-7 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-sm font-medium">
              注册邮箱
            </Label>
            <Input
              id="email"
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              disabled={submitting}
              className={AUTH_INPUT_CLASS}
            />
          </div>

          {error && <AuthAlert>{error}</AuthAlert>}

          <Button
            type="submit"
            className="h-11 w-full rounded-xl text-[15px]"
            disabled={submitting || !email.trim()}
          >
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            发送重置链接
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            <Link href="/login" className="text-primary hover:underline">
              返回登录
            </Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
