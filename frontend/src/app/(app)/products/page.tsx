"use client";

/**
 * 产品工位（2026-10-18 合并为**一个页面**）
 *
 * 用户口径：原先「图片与基础信息」和「定义」两个 tab 是两个页面，维护一个产品
 * 要来回切换；现在合并为一页三块：产品列表 → 基础信息/图片 → 定义。
 * 选中一个产品后，它的图片、基础信息、规格定义都在同一页可看可改（租户级产品可编辑）。
 *
 * 保留旧深链 `?tab=definitions`：不 404，进入后自动滚到「定义」区块。
 */
import { useEffect, useRef } from "react";

import { ProductsMediaTab } from "./tabs/products-media-tab";
import { ProductsDefinitionsTab } from "./tabs/products-definitions-tab";
import { PageHeader } from "@/components/shared";

export default function ProductsWorkstationPage() {
  const definitionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "definitions") {
      definitionsRef.current?.scrollIntoView({ block: "start" });
    }
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="产品"
        description="一个产品一页：基础信息、图片、规格定义（含利润/成本/包装）都在这里维护；单证与报价都引用这里的数据。"
      />

      <section className="space-y-4">
        <h2 className="text-lg font-medium">图片与基础信息</h2>
        <ProductsMediaTab />
      </section>

      <section ref={definitionsRef} className="space-y-4">
        <h2 className="text-lg font-medium">
          定义（规格 / 利润 / 包装 / HS 编码）
        </h2>
        <ProductsDefinitionsTab />
      </section>
    </div>
  );
}
