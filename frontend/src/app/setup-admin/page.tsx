"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth/auth-context";
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
import { Loader2 } from "lucide-react";

export default function SetupAdminPage() {
  const { setupAdmin } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (
      !email.trim() ||
      !password ||
      !displayName.trim() ||
      !setupToken.trim()
    ) {
      setError("请填写所有字段");
      return;
    }

    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }

    setSubmitting(true);
    try {
      await setupAdmin({
        email: email.trim(),
        password,
        display_name: displayName.trim(),
        setup_token: setupToken.trim(),
      });
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "初始化失败";

      if (status === 403) {
        setError("系统已初始化，无法重复创建管理员");
      } else if (status === 503) {
        setError("未配置初始化令牌（ADMIN_SETUP_TOKEN）");
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">初始化管理员</CardTitle>
          <CardDescription>一次性系统管理员创建</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">邮箱 *</Label>
              <Input
                id="email"
                type="email"
                placeholder="admin@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密码 *</Label>
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
              <Label htmlFor="displayName">姓名 *</Label>
              <Input
                id="displayName"
                placeholder="管理员姓名"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="setupToken">初始化令牌 *</Label>
              <Input
                id="setupToken"
                type="password"
                placeholder="ADMIN_SETUP_TOKEN"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                autoComplete="off"
                disabled={submitting}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              初始化
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
