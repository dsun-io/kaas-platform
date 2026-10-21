"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useCategory } from "../hooks/use-categories";
import { QuoteWizard } from "../components/QuoteWizard";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/shared";

function CategoryWizardInner() {
  const searchParams = useSearchParams();
  const categoryId = Number(searchParams.get("categoryId"));
  const { data: category, isLoading } = useCategory(categoryId);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="规格向导" description="正在加载品类与规格定义…" />
        <div className="space-y-3">
          <Skeleton className="h-10 w-2/3 rounded-lg" />
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-10 w-32 rounded-lg" />
        </div>
      </div>
    );
  }

  if (!category) {
    return (
      <div className="space-y-4">
        <PageHeader title="规格向导" description="当前品类不存在或已删除" />
        <div className="flex items-center gap-3">
          <p className="text-destructive">品类不存在</p>
          <Link href="/spec-config">
            <Button variant="outline">
              <ArrowLeft className="h-4 w-4 mr-2" />
              返回
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/spec-config">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            返回
          </Button>
        </Link>
        <PageHeader
          title={category.name}
          description="规格向导 — 填写属性并录入价格"
          className="flex-1"
        />
      </div>
      <QuoteWizard categoryId={categoryId} categoryName={category.name} />
    </div>
  );
}

export default function CategoryWizardPage() {
  return (
    <Suspense fallback={null}>
      <CategoryWizardInner />
    </Suspense>
  );
}
