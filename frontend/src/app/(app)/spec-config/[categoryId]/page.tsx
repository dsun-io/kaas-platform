"use client";

import { useParams } from "next/navigation";
import { useCategory } from "../hooks/use-categories";
import { QuoteWizard } from "../components/QuoteWizard";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function CategoryWizardPage() {
  const params = useParams();
  const categoryId = Number(params.categoryId);
  const { data: category, isLoading } = useCategory(categoryId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        加载品类...
      </div>
    );
  }

  if (!category) {
    return (
      <div className="space-y-4">
        <p className="text-destructive">品类不存在</p>
        <Link href="/spec-config">
          <Button variant="outline">
            <ArrowLeft className="h-4 w-4 mr-2" />
            返回
          </Button>
        </Link>
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
        <div>
          <h1 className="text-2xl font-semibold">{category.name}</h1>
          <p className="text-muted-foreground mt-1">
            规格向导 — 填写属性并录入价格
          </p>
        </div>
      </div>
      <QuoteWizard categoryId={categoryId} categoryName={category.name} />
    </div>
  );
}
