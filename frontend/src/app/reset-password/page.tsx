"use client";

import { Suspense, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AUTH_INPUT_CLASS,
  AuthAlert,
  AuthShell,
} from "@/components/auth/auth-shell";
import { CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";

/** 密码可见性切换按钮（与登录页同款交互） */
function PasswordVisibilityToggle({
  visible,
  disabled,
  onToggle,
}: {
  visible: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const label = visible ? "隐藏密码" : "显示密码";
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-label={label}
      aria-pressed={visible}
      title={label}
      className="absolute right-0 top-0 flex h-full w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
    >
      {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
    </button>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
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
    <AuthShell>
      <h2 className="text-xl font-semibold tracking-tight">重置密码</h2>
      <p className="mt-1 text-sm text-muted-foreground">设置你的新登录密码</p>

      {done ? (
        <div className="mt-10 flex flex-col items-center text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <CheckCircle2 className="size-8 text-primary" />
          </div>
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
            密码已重置，请用新密码登录。
          </p>
          <Button
            className="mt-6 h-11 w-full rounded-xl text-[15px]"
            onClick={() => router.push("/login")}
          >
            前往登录
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-7 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="password" className="text-sm font-medium">
              新密码
            </Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="至少 8 位"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                disabled={submitting}
                className={`${AUTH_INPUT_CLASS} pr-10`}
              />
              <PasswordVisibilityToggle
                visible={showPassword}
                disabled={submitting}
                onToggle={() => setShowPassword((v) => !v)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm" className="text-sm font-medium">
              确认新密码
            </Label>
            <div className="relative">
              <Input
                id="confirm"
                type={showConfirm ? "text" : "password"}
                placeholder="再次输入新密码"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                disabled={submitting}
                className={`${AUTH_INPUT_CLASS} pr-10`}
              />
              <PasswordVisibilityToggle
                visible={showConfirm}
                disabled={submitting}
                onToggle={() => setShowConfirm((v) => !v)}
              />
            </div>
          </div>

          {error && <AuthAlert>{error}</AuthAlert>}

          <Button
            type="submit"
            className="h-11 w-full rounded-xl text-[15px]"
            disabled={submitting}
          >
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            重置密码
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
