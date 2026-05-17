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

const CATEGORIES = [
  { value: "fencing", label: "围网/护栏类" },
  { value: "mesh_panel_roll", label: "网片/网卷类" },
  { value: "woven_mesh", label: "编织网类" },
  { value: "welded_mesh", label: "焊接网类" },
  { value: "perforated_mesh", label: "板网/冲孔网类" },
  { value: "wire_rope", label: "丝绳/线材类" },
  { value: "filter_mesh", label: "过滤/筛分网类" },
  { value: "gabion_protection", label: "箱笼/防护网类" },
  { value: "custom_wire_mesh", label: "定制异形丝网类" },
  { value: "other", label: "其他丝网产品" },
];

export default function RegisterPage() {
  const { register } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [productCategory, setProductCategory] = useState("");
  const [contact, setContact] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (
      !email.trim() ||
      !password ||
      !displayName.trim() ||
      !companyName.trim()
    ) {
      setError("请填写所有必填字段");
      return;
    }

    if (password.length < 8) {
      setError("密码至少 8 位");
      return;
    }

    if (password !== confirmPassword) {
      setError("两次密码输入不一致");
      return;
    }

    if (!productCategory) {
      setError("请选择主营丝网类型");
      return;
    }

    setSubmitting(true);
    try {
      await register({
        email: email.trim(),
        password,
        display_name: displayName.trim(),
        company_name: companyName.trim(),
        product_category: productCategory,
        contact: contact.trim() || undefined,
      });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? "注册失败，请稍后重试";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">免费注册</CardTitle>
          <CardDescription>创建您的报价管理账号</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">邮箱 *</Label>
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
            <div className="grid grid-cols-2 gap-3">
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
                <Label htmlFor="confirmPassword">确认密码 *</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="再次输入密码"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={submitting}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="displayName">姓名 *</Label>
              <Input
                id="displayName"
                placeholder="您的称呼"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="companyName">公司名称 *</Label>
              <Input
                id="companyName"
                placeholder="公司或工厂名称"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="productCategory">主营丝网类型 *</Label>
              <p className="text-xs text-muted-foreground">
                用于初始化报价模板，后续可继续添加具体产品。
              </p>
              <select
                id="productCategory"
                value={productCategory}
                onChange={(e) => setProductCategory(e.target.value)}
                disabled={submitting}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">请选择</option>
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact">联系方式</Label>
              <Input
                id="contact"
                placeholder="手机号或微信号（选填）"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                disabled={submitting}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
          <CardFooter className="flex flex-col gap-3">
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              注册
            </Button>
            <p className="text-sm text-muted-foreground text-center">
              已有账号？
              <Link href="/login" className="text-primary hover:underline ml-1">
                去登录
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
