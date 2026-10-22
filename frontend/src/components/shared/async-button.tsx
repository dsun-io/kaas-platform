"use client";

/**
 * 带 pending 状态的按钮（P0-C，配合 `useAsyncAction`）。
 *
 * 一行解决"防重"（P0-B B4）：mutation 进行中自动 `disabled` + `aria-busy`，
 * 文案换成「提交中…」，用户不会连点也不会以为没反应。
 * 只是 `Button` 的薄包装，不引入新样式（variant/size 原样透传）。
 */
import { Button } from "@/components/ui/button";

export interface AsyncButtonProps extends Omit<
  React.ComponentProps<typeof Button>,
  "children"
> {
  children?: React.ReactNode;
  /** 进行中：禁用 + 显示 pendingLabel */
  pending?: boolean;
  /** 进行中文案，默认「提交中…」 */
  pendingLabel?: React.ReactNode;
}

export function AsyncButton({
  pending = false,
  pendingLabel = "提交中…",
  disabled,
  children,
  ...props
}: AsyncButtonProps) {
  return (
    <Button
      {...props}
      disabled={disabled === true || pending}
      aria-busy={pending || undefined}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
