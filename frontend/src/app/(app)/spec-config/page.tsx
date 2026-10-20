"use client";

import { useRouter } from "next/navigation";
import { useCategoryTree } from "./hooks/use-categories";
import { CategoryPicker } from "./components/CategoryPicker";
import { PageHeader } from "@/components/shared";
import { Skeleton } from "@/components/ui/skeleton";

export default function SpecConfigPage() {
  const router = useRouter();
  const { data: categories, isLoading } = useCategoryTree();

  function handleSelect(categoryId: number) {
    router.push(`/spec-config/wizard?categoryId=${categoryId}`);
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="规格配置" description="选择品类后进入规格向导" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="规格配置" description="选择品类后进入规格向导" />
      <CategoryPicker categories={categories || []} onSelect={handleSelect} />
    </div>
  );
}
