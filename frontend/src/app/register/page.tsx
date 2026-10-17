"use client";

/**
 * 注册页 —— 账号 + **首次团队动作**。
 *
 * 为什么注册就要选团队/工位（docs/FRONTEND_PRODUCTION_READINESS.md §B1）：
 *   生产是单租户部署，数据隔离靠**团队**、能力边界靠**工位订阅**；
 *   注册后没有团队 = 看不到任何数据，且无法自救（要再找管理员）。
 *   所以注册时就把"新建团队（顺带开通工位）/ 凭邀请码加入"二选一做掉；
 *   也保留"稍后再说" —— 一个人只能属于一个团队，先随便建一个就再也加不进同事的团队了。
 *
 * 两个易错点：
 *   ① 新建团队与加入团队**互斥**（后端 422 TEAM_ACTION_CONFLICT），UI 只允许选一个；
 *   ② 工位多选默认全选，且**不允许全不选** —— 传空数组会得到一个"进得去但什么都用不了"
 *      的团队（后端把 `workstations=[]` 当成"一个都不开"）。
 */
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import type { RegisterRequest } from "@/lib/auth/types";
import { teamErrorMessage } from "@/lib/team/team-errors";
import { extractInviteToken } from "@/lib/team/invites";
import { subscribableWorkstationOptions } from "@/lib/workstation/visibility";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WorkstationPicker } from "@/components/workstation-picker";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Loader2, Users } from "lucide-react";

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

/** 工位选项来自契约（顺序与名称 = 侧边栏同一份，避免两处不一致） */
const ALL_STATION_KEYS = subscribableWorkstationOptions().map((s) => s.key);

type TeamMode = "create" | "join" | "none";

export default function RegisterPage() {
  const { register } = useAuth();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [productCategory, setProductCategory] = useState("");
  const [contact, setContact] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 团队动作（三选一，互斥：新建 / 加入 / 稍后再说）
  const [teamMode, setTeamMode] = useState<TeamMode>("create");
  const [teamName, setTeamName] = useState("");
  // 新建团队默认全选：当前所有工位免费，新团队一建好就能用（避免空壳团队）
  const [stations, setStations] = useState<string[]>(ALL_STATION_KEYS);
  const [inviteToken, setInviteToken] = useState("");

  // 从邀请链接进来（/register?token=xxx）→ 默认走"加入团队"并预填邀请码，
  // 这样同事发来的链接点开即用，不需要再手抄一遍码
  const tokenFromLink = searchParams?.get("token") ?? "";
  useEffect(() => {
    if (!tokenFromLink) return;
    setTeamMode("join");
    setInviteToken(tokenFromLink);
  }, [tokenFromLink]);

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

    if (teamMode === "create") {
      if (!teamName.trim()) {
        setError("请填写团队名称");
        return;
      }
      if (stations.length === 0) {
        setError("请至少勾选一个要开通的工位（当前全部免费）");
        return;
      }
    } else if (teamMode === "join" && extractInviteToken(inviteToken) === "") {
      setError("请填写邀请码或整条邀请链接");
      return;
    }

    // 团队动作二选一（也可以都不选）：只带其中一个参数，
    // 避免后端 422 TEAM_ACTION_CONFLICT
    const payload: RegisterRequest = {
      email: email.trim(),
      password,
      display_name: displayName.trim(),
      company_name: companyName.trim(),
      product_category: productCategory,
      contact: contact.trim() || undefined,
    };
    if (teamMode === "create") {
      payload.team_name = teamName.trim();
      payload.workstations = stations;
    } else if (teamMode === "join") {
      // 整条邀请链接也可以：后端 normalize_invite_token 会自己取 ?token=
      payload.invite_token = inviteToken.trim();
    }

    setSubmitting(true);
    try {
      await register(payload);
    } catch (err: unknown) {
      // 团队类错误码给中文（并保留后端 message/detail，不吞掉）
      setError(teamErrorMessage(err, "注册失败，请稍后重试"));
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

            {/* ── 团队（二选一）────────────────────────────────────────── */}
            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">团队</span>
                <span className="text-xs text-muted-foreground">
                  二选一；工位订阅挂在团队上
                </span>
              </div>

              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="radio"
                    name="teamMode"
                    checked={teamMode === "create"}
                    onChange={() => setTeamMode("create")}
                    disabled={submitting}
                  />
                  新建团队（我当管理员）
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="radio"
                    name="teamMode"
                    checked={teamMode === "join"}
                    onChange={() => setTeamMode("join")}
                    disabled={submitting}
                  />
                  加入现有团队
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="radio"
                    name="teamMode"
                    checked={teamMode === "none"}
                    onChange={() => setTeamMode("none")}
                    disabled={submitting}
                  />
                  稍后再说
                </label>
              </div>

              {teamMode === "none" && (
                <p className="text-xs text-muted-foreground">
                  可以先进去：登录后在「团队与工位」里创建或凭邀请码加入团队。
                  注意一个人同一时刻只能属于一个团队 ——
                  先随便建一个团队，之后就没法再加入同事的团队了，所以不确定时选这一项。
                </p>
              )}

              {teamMode === "create" ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="teamName">团队名称 *</Label>
                    <Input
                      id="teamName"
                      placeholder="如：安平县联佳丝网制品有限公司"
                      value={teamName}
                      onChange={(e) => setTeamName(e.target.value)}
                      disabled={submitting}
                    />
                  </div>
                  <WorkstationPicker
                    value={stations}
                    onChange={setStations}
                    disabled={submitting}
                    idPrefix="register"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="inviteToken">邀请码 / 邀请链接 *</Label>
                  <Input
                    id="inviteToken"
                    placeholder="粘贴同事发来的邀请链接或邀请码"
                    value={inviteToken}
                    onChange={(e) => setInviteToken(e.target.value)}
                    disabled={submitting}
                  />
                  <p className="text-xs text-muted-foreground">
                    整条邀请链接直接粘贴即可，系统会自动识别其中的邀请码。
                  </p>
                </div>
              )}
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
