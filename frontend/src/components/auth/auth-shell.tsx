import type { ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";

/**
 * 认证页外壳（登录 / 注册 / 忘记密码 / 重置密码 共用）。
 *
 * 视觉口径来自 2026-10-20 改版后的 `app/login/page.tsx`：
 * 石墨冷灰底 + 电光蓝主色，左侧品牌信息、右侧表单的毛玻璃卡。
 * 这里只复制结构，不承载任何业务逻辑；表单内容由各页作为 children 传入。
 */

const HIGHLIGHTS = [
  "客户、询盘与报价统一台账",
  "整单参数与单证自动衔接",
  "团队与工位权限隔离",
];

/** 输入框统一样式（与登录页一致：白/80 底 + 白色描边 + 圆角） */
export const AUTH_INPUT_CLASS =
  "h-10 rounded-xl border-slate-200/90 bg-white/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]";

/** 认证页统一错误提示（与登录页的 role=alert 同款） */
export function AuthAlert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      {children}
    </div>
  );
}

export function AuthShell({
  children,
  wide = false,
}: {
  children: ReactNode;
  /** 表单字段多的页面（注册）用宽卡，避免右侧表单过窄 */
  wide?: boolean;
}) {
  return (
    <div className="login-backdrop relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute -left-24 -top-24 size-80 rounded-full bg-primary/15 blur-3xl" />
      <div className="pointer-events-none absolute -right-20 top-1/3 size-96 rounded-full bg-sky-300/20 blur-3xl" />

      <div
        className={`relative grid w-full overflow-hidden rounded-[28px] border border-white/70 bg-white/60 shadow-[0_30px_80px_-30px_rgba(30,35,80,0.35)] backdrop-blur-2xl md:grid-cols-[1.05fr_1fr] ${
          wide ? "max-w-[1120px]" : "max-w-[980px]"
        }`}
      >
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

        {/* 表单侧 */}
        <div className="p-8 sm:p-10">
          <div className="mb-8 flex items-center gap-2 md:hidden">
            <img
              src="/assets/brand/logo-lockup.png"
              alt="PowerVoy"
              className="h-7 w-auto"
            />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
