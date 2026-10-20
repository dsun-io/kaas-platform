"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Eye, EyeOff, CheckCircle2 } from "lucide-react";

const HIGHLIGHTS = [
  "客户、询盘与报价统一台账",
  "整单参数与单证自动衔接",
  "团队与工位权限隔离",
];

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!email.trim() || !password) {
      setError("请输入邮箱和密码");
      return;
    }

    setSubmitting(true);
    try {
      await login(email.trim(), password, rememberMe);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "登录失败，请稍后重试";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-backdrop relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute -left-24 -top-24 size-80 rounded-full bg-primary/15 blur-3xl" />
      <div className="pointer-events-none absolute -right-20 top-1/3 size-96 rounded-full bg-sky-300/20 blur-3xl" />

      <div className="relative grid w-full max-w-[980px] overflow-hidden rounded-[28px] border border-white/70 bg-white/60 shadow-[0_30px_80px_-30px_rgba(30,35,80,0.35)] backdrop-blur-2xl md:grid-cols-[1.05fr_1fr]">
        {/* 品牌侧：纯展示，不承载任何业务逻辑 */}
        <div className="relative hidden flex-col justify-between gap-10 border-r border-white/60 bg-gradient-to-br from-primary/[0.10] via-white/20 to-transparent p-10 md:flex">
          <img
            src="/assets/brand/logo-lockup.png"
            alt="PowerVoy"
            className="h-8 w-auto max-w-[160px] self-start"
          />
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary/80">
              智能报价平台
            </p>
            <h1 className="mt-3 text-[26px] font-semibold leading-snug text-foreground">
              外贸报价与单证
              <br />
              一体化工作台
            </h1>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
              从成本、算价到单证签发，一条线完成；客户与团队数据集中管理。
            </p>
            <ul className="mt-7 space-y-2.5 text-sm text-muted-foreground">
              {HIGHLIGHTS.map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-primary/70" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground/70">
            PowerVoy · 智能报价平台
          </p>
        </div>

        {/* 表单侧：与改造前完全一致的登录逻辑 */}
        <div className="p-8 sm:p-10">
          <div className="mb-8 flex items-center gap-2 md:hidden">
            <img
              src="/assets/brand/logo-lockup.png"
              alt="PowerVoy"
              className="h-7 w-auto"
            />
          </div>

          <h2 className="text-xl font-semibold tracking-tight">登录</h2>
          <p className="mt-1 text-sm text-muted-foreground">登录报价管理平台</p>

          <form onSubmit={handleSubmit} className="mt-7 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium">
                邮箱
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
                className="h-10 rounded-xl border-white/70 bg-white/80"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-medium">
                密码
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="输入密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={submitting}
                  className="h-10 rounded-xl border-white/70 bg-white/80 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  disabled={submitting}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  title={showPassword ? "隐藏密码" : "显示密码"}
                  className="absolute right-0 top-0 flex h-full w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {showPassword ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="size-4 rounded border-border"
                />
                记住我
              </label>
              <Link
                href="/forgot-password"
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                忘记密码？
              </Link>
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="h-11 w-full rounded-xl text-[15px]"
              disabled={submitting}
            >
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              登录
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              没有账号？
              <Link
                href="/register"
                className="ml-1 text-primary hover:underline"
              >
                免费注册
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
