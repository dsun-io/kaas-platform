import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  // 浏览器自动填充检测：
  // 浏览器 autofill 直接设置 DOM value 但不触发 input 事件，
  // 导致 React 受控组件 state 不同步。
  // 方案：监听 :-webkit-autofill CSS 动画事件，手动派发 input 事件
  // 触发 React onChange。
  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;

    const onAnimation = (e: AnimationEvent) => {
      if (e.animationName === "autoFillStart") {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };

    el.addEventListener("animationstart", onAnimation);
    return () => el.removeEventListener("animationstart", onAnimation);
  }, []);

  return (
    <InputPrimitive
      ref={inputRef}
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
