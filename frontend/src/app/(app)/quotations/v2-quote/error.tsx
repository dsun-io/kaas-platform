"use client";

import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function V2QuoteError({ error, reset }: Props) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16">
      <AlertCircle className="size-8 text-destructive" />
      <h2 className="text-lg font-semibold">页面加载失败</h2>
      <p className="max-w-md text-center text-sm text-muted-foreground">
        {error.message || "发生未知错误，请稍后重试"}
      </p>
      <Button variant="outline" size="sm" onClick={reset}>
        重试
      </Button>
    </div>
  );
}
