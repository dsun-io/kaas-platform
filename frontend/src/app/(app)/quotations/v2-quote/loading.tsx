import { Skeleton } from "@/components/ui/skeleton";

export default function V2QuoteLoading() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-2 h-4 w-64" />
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <div className="rounded-lg border p-4 space-y-3">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-24" />
          </div>
        </div>
        <div className="lg:col-span-3">
          <div className="rounded-lg border p-4 flex items-center justify-center h-40">
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
      </div>
    </div>
  );
}
