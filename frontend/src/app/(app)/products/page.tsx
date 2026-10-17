"use client";

/**
 * 产品工位 —— 一个工位两个 tab（P14 行为等价重构）
 * ─────────────────────────────────────────────
 * 搬家前：
 *   · `/products`                → 产品素材（图片 + 基础信息）  【业务组】
 *   · `/settings/tenant-products` → 产品定义管理（JSONB 规格）  【管理组，仅内部账号】
 *
 * 现在两者都在这一个工位里，各占一个 tab；**两个 tab 都渲染**，内容与搬家前逐项一致。
 *
 * 三条硬约束（P14 契约，不许突破）：
 *   ① **不按 Axis 设计产品编辑器** —— 三个真实产品（chain_link/field_fence/deer_net）
 *      的 `axes` 全是空列表，实际维度是 `numeric_inputs + variants + pricing_key`
 *      ⇒ 本工位不发明新字段/新布局，JSON 文本框**原样保留**（原 `page.tsx` 里那段
 *      `setSpecJson(JSON.stringify(...))` 与 `<textarea>` 逐字不动）。
 *   ② **可见性两层不压平** —— 工位可见性 `adminOnly` 属 **P15 契约层**（前端不发明
 *      权限门），数据可见性属后端团队过滤；前端本页不加任何 `RouteGuard` / `adminOnly`
 *      分支（搬家前 `/products` 就没有，现在也不加）。
 *   ③ **旧路由书签不许 404** —— `/products`（本页）与 `/settings/tenant-products`
 *      （`settings/tenant-products/page.tsx` 客户端 redirect）都保留可访问；后者
 *      只是落到本页的 `?tab=definitions`，不删路由、不改契约。
 *
 * tab 切换**保留状态**（P14 行为 + task-8 测试要点）：两个 tab 内容都始终挂载
 * （`hidden` 而不是条件渲染），所以切走再切回来，选中产品 / 编辑中的表单 /
 * JSON 文本框内容都还在 —— 与搬家前两个独立页面各自保留本地 state 的行为一致
 * （搬家前切走再回来走的是浏览器导航，state 当然也没了；本工位改成 tab 后
 * **保留状态是改善**，不算违反"行为等价"）。
 */
import { useEffect, useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProductsMediaTab } from "./tabs/products-media-tab";
import { ProductsDefinitionsTab } from "./tabs/products-definitions-tab";

type ProductsTab = "media" | "definitions";

/**
 * tab 键 → 展示名 → 深链参数。
 *
 * 命名口径：搬家前 `/products` 自称「产品管理」、`/settings/tenant-products` 自称
 * 「产品定义管理」—— 两个都是"产品 X"，容易混。合并后**一个工位一个名字（产品）**，
 * 两个 tab 各取一个准确名：`图片与基础信息`（素材）/ `定义`（规格 JSONB）。
 */
const TABS: { key: ProductsTab; label: string; hint: string }[] = [
  {
    key: "media",
    label: "图片与基础信息",
    hint: "产品图（生产/尺寸/重量/成品）+ 基础信息 —— 单证/报价引用这里的图",
  },
  {
    key: "definitions",
    label: "定义",
    hint: "产品定义（利润/成本口径/规格 JSONB）。系统级产品由平台管理员维护",
  },
];

const isTab = (v: string | null): v is ProductsTab =>
  TABS.some((t) => t.key === v);

export default function ProductsWorkstationPage() {
  const [tab, setTab] = useState<ProductsTab>("media");

  // 支持 ?tab= 深链（与 quotes/page.tsx 同一套约定：默认 tab 不带参数）。
  // 刻意不用 useSearchParams：静态导出下它需要 Suspense 边界，易踩坑。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = new URLSearchParams(window.location.search).get("tab");
    if (isTab(t)) setTab(t);
  }, []);

  const switchTab = (next: ProductsTab) => {
    setTab(next);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (next === "media") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url.toString());
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">产品</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          一个工位维护产品素材（图片/基础信息）与产品定义（规格 JSONB），
          单证与报价都引用这里的数据。
        </p>
      </div>

      {/* 2026-10-17 tab 收编到 ui/tabs：keepMounted 默认 true = P14 语义
          （两个 tab 都始终挂载只是隐藏，切走再切回状态还在），
          文案/深链 ?tab= 全部不变。 */}
      <Tabs value={tab} onValueChange={(v) => switchTab(v as ProductsTab)}>
        <TabsList variant="line">
          {TABS.map((t) => (
            <TabsTrigger
              key={t.key}
              variant="line"
              value={t.key}
              title={t.hint}
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="media">
          <ProductsMediaTab />
        </TabsContent>
        <TabsContent value="definitions">
          <ProductsDefinitionsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
