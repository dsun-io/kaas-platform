"use client";

/**
 * 注册页 —— 账号 + **首次团队动作**。
 *
 * 为什么注册就要选团队/工位（docs/FRONTEND_PRODUCTION_READINESS.md §B1）：
 *   生产是单租户部署，数据隔离靠**团队**、能力边界靠**工位订阅**；
 *   注册后没有团队 = 看不到任何数据，且无法自救（要再找管理员）。
 *   所以注册时就把"新建团队（顺带开通工位）/ 凭邀请码加入 / 向已存在团队发起
 *   加入申请"三选一做掉；也保留"稍后再说" —— 一个人只能属于一个团队，
 *   先随便建一个就再也加不进同事的团队了。
 *
 * 几个易错点：
 *   ① 新建 / 邀请码 / 加入申请**三方互斥**（后端 422 TEAM_ACTION_CONFLICT），UI 只允许选一个；
 *   ② 工位多选默认全选，且**不允许全不选** —— 传空数组会得到一个"进得去但什么都用不了"
 *      的团队（后端把 `workstations=[]` 当成"一个都不开"）；
 *   ③ 团队名查重（2026-10-22 新增）：输入团队名后 debounce 调
 *      `GET /teams/check-name`（只回布尔，**不暴露团队列表**）；
 *      已存在 → 引导改走"申请加入"或"填邀请码"；不存在 → 提示可新建。
 *      查重失败（网络/接口异常）不拦提交 —— 后端仍是唯一真源（409 TEAM_NAME_TAKEN）。
 *
 * 视觉：2026-10-21 起与登录页同一套新版权威口径（`app/login/page.tsx`）——
 *   复用 `components/auth/auth-shell.tsx` 的 AuthShell wide 外壳 + 毛玻璃分区表单，
 *   字段、校验、payload 与改造前一致。
 */
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth/auth-context";
import type { RegisterRequest } from "@/lib/auth/types";
import apiClient from "@/lib/api/client";
import { teamErrorMessage } from "@/lib/team/team-errors";
import { extractInviteToken } from "@/lib/team/invites";
import { subscribableWorkstationOptions } from "@/lib/workstation/visibility";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WorkstationPicker } from "@/components/workstation-picker";
import {
  AuthAlert,
  AuthShell,
  AUTH_INPUT_CLASS,
} from "@/components/auth/auth-shell";
import { cn } from "@/lib/utils";
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

type TeamMode = "create" | "join" | "apply" | "none";

/** 团队四选一的卡片式单选（原生 radio 保留，键盘/读屏可正常操作） */
const TEAM_MODE_OPTIONS: {
  value: TeamMode;
  label: string;
  hint: string;
}[] = [
  { value: "create", label: "新建团队", hint: "我当管理员，并开通工位" },
  { value: "join", label: "凭邀请码加入", hint: "已有同事给的邀请码 / 链接" },
  { value: "apply", label: "申请加入团队", hint: "团队已存在，请管理员审核" },
  { value: "none", label: "稍后再说", hint: "先进入，登录后再设置" },
];

/** 团队名查重的防抖间隔（毫秒）：太短会每敲一个字打一次接口 */
const NAME_CHECK_DEBOUNCE_MS = 400;

export default function RegisterPage() {
  const { register } = useAuth();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [productCategory, setProductCategory] = useState("");
  const [contact, setContact] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 团队动作（四选一，互斥：新建 / 邀请码 / 申请 / 稍后再说）
  const [teamMode, setTeamMode] = useState<TeamMode>("create");
  const [teamName, setTeamName] = useState("");
  // 新建团队默认全选：当前所有工位免费，新团队一建好就能用（避免空壳团队）
  const [stations, setStations] = useState<string[]>(ALL_STATION_KEYS);
  const [inviteToken, setInviteToken] = useState("");
  const [applyMessage, setApplyMessage] = useState("");
  // 团队名是否已存在：null = 未查/查失败（不拦提交），true/false = 查询结果
  const [nameExists, setNameExists] = useState<boolean | null>(null);
  const [nameChecking, setNameChecking] = useState(false);

  // 从邀请链接进来（/register?token=xxx）→ 默认走"加入团队"并预填邀请码，
  // 这样同事发来的链接点开即用，不需要再手抄一遍码
  const tokenFromLink = searchParams?.get("token") ?? "";
  useEffect(() => {
    if (!tokenFromLink) return;
    setTeamMode("join");
    setInviteToken(tokenFromLink);
  }, [tokenFromLink]);

  // 团队名查重（新建 / 申请两种模式都要知道"这个名字到底存不存在"）
  useEffect(() => {
    const name = teamName.trim();
    const shouldCheck =
      (teamMode === "create" || teamMode === "apply") && name.length >= 2;
    if (!shouldCheck) {
      setNameExists(null);
      setNameChecking(false);
      return;
    }
    let cancelled = false;
    setNameChecking(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { data } = await apiClient.get<{ exists?: unknown }>(
            "/teams/check-name",
            { params: { name }, silent: true },
          );
          if (!cancelled) setNameExists(data?.exists === true);
        } catch {
          // 查重失败不阻断注册：后端建团队/申请时仍会给出准确结果
          if (!cancelled) setNameExists(null);
        } finally {
          if (!cancelled) setNameChecking(false);
        }
      })();
    }, NAME_CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [teamMode, teamName]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (!email.trim() || !password || !displayName.trim()) {
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
      if (nameExists === true) {
        setError(
          "该团队已存在：请改用「申请加入团队」（等管理员审核）或「凭邀请码加入」",
        );
        return;
      }
      if (stations.length === 0) {
        setError("请至少勾选一个要开通的工位（当前全部免费）");
        return;
      }
    } else if (teamMode === "join" && extractInviteToken(inviteToken) === "") {
      setError("请填写邀请码或整条邀请链接");
      return;
    } else if (teamMode === "apply") {
      if (!teamName.trim()) {
        setError("请填写要加入的团队名称");
        return;
      }
      if (nameExists === false) {
        setError("没有找到这个团队，请核对团队名称（或改为新建团队）");
        return;
      }
    }

    // 团队动作三选一（也可以都不选）：只带其中一个参数，
    // 避免后端 422 TEAM_ACTION_CONFLICT
    const payload: RegisterRequest = {
      email: email.trim(),
      password,
      display_name: displayName.trim(),
      product_category: productCategory,
      contact: contact.trim() || undefined,
    };
    if (teamMode === "create") {
      payload.team_name = teamName.trim();
      payload.workstations = stations;
    } else if (teamMode === "join") {
      // 整条邀请链接也可以：后端 normalize_invite_token 会自己取 ?token=
      payload.invite_token = inviteToken.trim();
    } else if (teamMode === "apply") {
      payload.apply_team_name = teamName.trim();
      if (applyMessage.trim()) payload.apply_message = applyMessage.trim();
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

  const teamNameInput = (
    <div className="space-y-2">
      <Label htmlFor="teamName" className="text-sm font-medium">
        团队名称 *
      </Label>
      <Input
        id="teamName"
        placeholder="如：安平县联佳丝网制品有限公司"
        value={teamName}
        onChange={(e) => setTeamName(e.target.value)}
        disabled={submitting}
        aria-describedby="team-name-hint"
        className={AUTH_INPUT_CLASS}
      />
      <p
        id="team-name-hint"
        className="text-xs leading-relaxed text-muted-foreground"
      >
        {nameChecking
          ? "正在查询该团队是否存在…"
          : nameExists === true
            ? `团队「${teamName.trim()}」已存在：可以申请加入（管理员审核），或改用邀请码加入。`
            : nameExists === false
              ? `没有找到团队「${teamName.trim()}」：确认名称无误后可新建。`
              : "填写公司/团队全称；系统会检查是否已存在。"}
      </p>
    </div>
  );

  return (
    <AuthShell wide>
      <h2 className="text-xl font-semibold tracking-tight">免费注册</h2>
      <p className="mt-1 text-sm text-muted-foreground">创建您的报价管理账号</p>

      <form onSubmit={handleSubmit} className="mt-7 space-y-6">
        {/* ── 账号 ─────────────────────────────────────────────────── */}
        <section
          aria-labelledby="register-account-heading"
          className="space-y-4"
        >
          <div>
            <h3
              id="register-account-heading"
              className="text-sm font-medium text-foreground"
            >
              账号信息
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              用于登录与团队内的身份识别
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email" className="text-sm font-medium">
              邮箱 *
            </Label>
            <Input
              id="email"
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              disabled={submitting}
              className={AUTH_INPUT_CLASS}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-medium">
                密码 *
              </Label>
              <Input
                id="password"
                type="password"
                placeholder="至少 8 位"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                disabled={submitting}
                className={AUTH_INPUT_CLASS}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword" className="text-sm font-medium">
                确认密码 *
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder="再次输入密码"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                disabled={submitting}
                className={AUTH_INPUT_CLASS}
              />
            </div>
          </div>
        </section>

        <div
          aria-hidden="true"
          className="h-px bg-gradient-to-r from-transparent via-slate-300/60 to-transparent"
        />

        {/* ── 资料 ─────────────────────────────────────────────────── */}
        <section
          aria-labelledby="register-profile-heading"
          className="space-y-4"
        >
          <div>
            <h3
              id="register-profile-heading"
              className="text-sm font-medium text-foreground"
            >
              个人资料
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              用于初始化报价模板与联系信息
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="displayName" className="text-sm font-medium">
                姓名 *
              </Label>
              <Input
                id="displayName"
                placeholder="您的称呼"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={submitting}
                className={AUTH_INPUT_CLASS}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact" className="text-sm font-medium">
                联系方式
              </Label>
              <Input
                id="contact"
                placeholder="手机号或微信号（选填）"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                disabled={submitting}
                className={AUTH_INPUT_CLASS}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="productCategory" className="text-sm font-medium">
              主营丝网类型 *
            </Label>
            <select
              id="productCategory"
              value={productCategory}
              onChange={(e) => setProductCategory(e.target.value)}
              disabled={submitting}
              className="h-10 w-full rounded-xl border border-slate-200/90 bg-white/85 px-3 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">请选择</option>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              用于初始化报价模板，后续可继续添加具体产品。
            </p>
          </div>
        </section>

        <div
          aria-hidden="true"
          className="h-px bg-gradient-to-r from-transparent via-slate-300/60 to-transparent"
        />

        {/* ── 团队（四选一）────────────────────────────────────────── */}
        <section
          aria-labelledby="register-team-heading"
          className="space-y-4 rounded-2xl border border-white/80 bg-primary/[0.04] p-4"
        >
          <div className="flex items-start gap-2">
            <Users className="mt-0.5 size-4 shrink-0 text-primary/70" />
            <div className="min-w-0">
              <h3
                id="register-team-heading"
                className="text-sm font-medium text-foreground"
              >
                团队与工位
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                四选一；工位订阅挂在团队上
              </p>
            </div>
          </div>

          <div
            role="radiogroup"
            aria-labelledby="register-team-heading"
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {TEAM_MODE_OPTIONS.map((opt) => {
              const selected = teamMode === opt.value;
              return (
                <label
                  key={opt.value}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors",
                    selected
                      ? "border-primary/40 bg-primary/[0.06]"
                      : "border-slate-200/80 bg-white/70 hover:border-primary/30 hover:bg-white/90",
                    submitting && "cursor-not-allowed opacity-60",
                  )}
                >
                  <input
                    type="radio"
                    name="teamMode"
                    value={opt.value}
                    checked={selected}
                    onChange={() => setTeamMode(opt.value)}
                    disabled={submitting}
                    aria-describedby={`team-mode-hint-${opt.value}`}
                    className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium leading-tight text-foreground">
                      {opt.label}
                    </span>
                    <span
                      id={`team-mode-hint-${opt.value}`}
                      className="mt-1 block text-xs leading-snug text-muted-foreground"
                    >
                      {opt.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          {teamMode === "none" && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              可以先进去：登录后在「团队与工位」里创建或凭邀请码加入团队。
              注意一个人同一时刻只能属于一个团队 ——
              先随便建一个团队，之后就没法再加入同事的团队了，所以不确定时选这一项。
            </p>
          )}

          {teamMode === "create" && (
            <div className="space-y-4">
              {teamNameInput}
              {nameExists === true && (
                <div className="space-y-2 rounded-xl border border-warning/40 bg-warning-muted p-3">
                  <p className="text-xs leading-relaxed text-warning-muted-foreground">
                    团队「{teamName.trim()}
                    」已存在，不能重复创建。你可以直接向它发起
                    加入申请（团队管理员审核通过后入团），或改用同事给的邀请码。
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={submitting}
                      onClick={() => setTeamMode("apply")}
                    >
                      改为申请加入
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={submitting}
                      onClick={() => setTeamMode("join")}
                    >
                      我有邀请码
                    </Button>
                  </div>
                </div>
              )}
              <WorkstationPicker
                value={stations}
                onChange={setStations}
                disabled={submitting}
                idPrefix="register"
              />
            </div>
          )}

          {teamMode === "join" && (
            <div className="space-y-2">
              <Label htmlFor="inviteToken" className="text-sm font-medium">
                邀请码 / 邀请链接 *
              </Label>
              <Input
                id="inviteToken"
                placeholder="粘贴同事发来的邀请链接或邀请码"
                value={inviteToken}
                onChange={(e) => setInviteToken(e.target.value)}
                disabled={submitting}
                className={AUTH_INPUT_CLASS}
              />
              <p className="text-xs text-muted-foreground">
                整条邀请链接直接粘贴即可，系统会自动识别其中的邀请码。
                没有邀请码？填团队名选择「申请加入团队」，由管理员审核。
              </p>
            </div>
          )}

          {teamMode === "apply" && (
            <div className="space-y-4">
              {teamNameInput}
              <div className="space-y-2">
                <Label htmlFor="applyMessage" className="text-sm font-medium">
                  给管理员的留言（选填）
                </Label>
                <textarea
                  id="applyMessage"
                  placeholder="例如：我是销售部张三，公司邮箱是…（≤200 字）"
                  maxLength={200}
                  value={applyMessage}
                  onChange={(e) => setApplyMessage(e.target.value)}
                  disabled={submitting}
                  className="min-h-[76px] w-full rounded-xl border border-slate-200/90 bg-white/85 px-3 py-2 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <p className="text-xs text-muted-foreground">
                  提交后账号立即创建，但需要团队管理员审核通过才入团（可在「团队与工位」
                  查看进度、撤回申请）。
                  {applyMessage.length > 0 &&
                    ` 已输入 ${applyMessage.length}/200 字。`}
                </p>
              </div>
            </div>
          )}
        </section>

        {error && <AuthAlert>{error}</AuthAlert>}

        <div className="space-y-3">
          <Button
            type="submit"
            className="h-11 w-full rounded-xl text-[15px]"
            disabled={submitting}
          >
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            {teamMode === "apply" ? "提交申请并注册" : "注册"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            已有账号？
            <Link href="/login" className="ml-1 text-primary hover:underline">
              去登录
            </Link>
          </p>
        </div>
      </form>
    </AuthShell>
  );
}
