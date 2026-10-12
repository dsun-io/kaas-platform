"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
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
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">忘记密码</CardTitle>
          <CardDescription>通过注册邮箱重置密码</CardDescription>
        </CardHeader>
        {sent ? (
          <CardContent className="space-y-4 text-center">
            <MailCheck className="mx-auto size-10 text-primary" />
            <p className="text-sm text-muted-foreground">
              如果该邮箱已注册，重置链接已发送。
              <br />
              请检查收件箱（含垃圾邮件），链接 30 分钟内有效。
            </p>
            <Link
              href="/login"
              className="text-sm text-primary hover:underline"
            >
              返回登录
            </Link>
          </CardContent>
        ) : (
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">注册邮箱</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  disabled={submitting}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </CardContent>
            <CardFooter className="flex flex-col gap-3">
              <Button
                type="submit"
                className="w-full"
                disabled={submitting || !email.trim()}
              >
                {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
                发送重置链接
              </Button>
              <Link
                href="/login"
                className="text-sm text-muted-foreground hover:text-foreground text-center"
              >
                返回登录
              </Link>
            </CardFooter>
          </form>
        )}
      </Card>
    </div>
  );
}
