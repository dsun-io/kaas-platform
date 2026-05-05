import { Skeleton } from "@/components/ui/skeleton";

export default function KbLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border p-4 space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-12" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border p-6">
        <Skeleton className="h-5 w-32 mb-4" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}
