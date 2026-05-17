"use client";

import { useRouter } from "next/navigation";
import { useCategoryTree } from "./hooks/use-categories";
import { CategoryPicker } from "./components/CategoryPicker";
import { Loader2 } from "lucide-react";

export default function SpecConfigPage() {
  const router = useRouter();
  const { data: categories, isLoading } = useCategoryTree();

  function handleSelect(categoryId: number) {
    router.push(`/spec-config/${categoryId}`);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        加载品类...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">规格配置</h1>
        <p className="text-muted-foreground mt-1">选择品类后进入规格向导</p>
      </div>
      <CategoryPicker categories={categories || []} onSelect={handleSelect} />
    </div>
  );
}
