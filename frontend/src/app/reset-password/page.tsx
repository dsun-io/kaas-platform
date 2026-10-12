"use client";

import { Suspense, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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
import { Loader2, CheckCircle2 } from "lucide-react";

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    if (!token) {
      setError("重置链接无效，请重新申请");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post("/auth/reset-password", {
        token,
        new_password: password,
      });
      setDone(true);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: { message?: string } } } })
          ?.response?.data?.detail?.message ?? "重置失败，请稍后重试";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">重置密码</CardTitle>
          <CardDescription>设置你的新登录密码</CardDescription>
        </CardHeader>
        {done ? (
          <CardContent className="space-y-4 text-center">
            <CheckCircle2 className="mx-auto size-10 text-primary" />
            <p className="text-sm text-muted-foreground">
              密码已重置，请用新密码登录。
            </p>
            <Button className="w-full" onClick={() => router.push("/login")}>
              前往登录
            </Button>
          </CardContent>
        ) : (
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">新密码</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="至少 8 位"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={submitting}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm">确认新密码</Label>
                <Input
                  id="confirm"
                  type="password"
                  placeholder="再次输入新密码"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  disabled={submitting}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </CardContent>
            <CardFooter className="flex flex-col gap-3">
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
                重置密码
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
