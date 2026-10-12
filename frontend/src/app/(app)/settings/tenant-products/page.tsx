"use client";

/**
 * 旧路由 `/settings/tenant-products` → `/products?tab=definitions`（P14 硬约束③）
 *
 * 搬家前这里是「产品定义管理」独立页面（管理组、adminOnly:true）。
 * P14 把内容搬进产品工位的「定义」tab 后，**书签不许 404** —— 所以这条
 * 路径保留一个薄客户端 redirect，只负责把用户送到新家（不渲染任何内容、
 * 不做任何可见性判断：工位可见性属 P15 契约层，前端不发明权限门）。
 *
 * 为什么是客户端 redirect 而不是 `next.config.mjs` 的 `redirects()`：
 *   部署形态是 **静态导出**（`NEXT_EXPORT=1` 时 `output: "export"`），
 *   Next 的 `redirects()` 在静态导出下**不生效**（只有 rewrites 可选，且也只在
 *   dev/standalone 下有），所以这里用 `useRouter().replace` 是唯一在静态站点上
 *   真正落地的 redirect 方案。副作用：首屏会短暂渲染一个占位块（<100ms），
 *   用户几乎无感，且路径本身始终 200。
 *
 * typedRoutes：`next.config.mjs` 开了 `experimental.typedRoutes`，字符串里带
 * `?query` 不会被认作合法 Route（TS2345/TS2322），所以这里用 `as Route` 显式
 * 断言 —— 与 `onboarding/page.tsx` 既有 2 个 TS2322 同源（历史遗留，本步不修）。
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";

export default function TenantProductsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/products?tab=definitions" as Route);
  }, [router]);

  return (
    <div className="py-10 text-center text-sm text-muted-foreground">
      正在前往「产品 → 定义」…
    </div>
  );
}
