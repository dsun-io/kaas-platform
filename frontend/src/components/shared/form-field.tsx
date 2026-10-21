"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

/**
 * FormField —— 统一表单字段骨架（标签 + 控件 + 错误提示）。
 *
 * 收编「placeholder 当 label」的旧写法（customers 页三个表单）：
 * 占位符在输入后即消失，用户回看时不知道字段是什么；错误信息此前是
 * 裸 `text-destructive` 逃逸值。本组件把三件套的语义一次给全。
 */

interface FormFieldProps extends React.ComponentProps<"div"> {
  /** 字段标签；`required` 时带星号 */
  label: string;
  required?: boolean;
  /** 错误文案；非空时以 destructive 令牌渲染，并给控件标 aria-invalid */
  error?: string | null;
  /** 关联控件 id（点标签可聚焦控件） */
  htmlFor?: string;
}

function FormField({
  className,
  label,
  required = false,
  error = null,
  htmlFor,
  children,
  ...props
}: FormFieldProps) {
  const errorId = htmlFor ? `${htmlFor}-error` : undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)} {...props}>
      <Label htmlFor={htmlFor} className="flex items-center gap-0.5">
        {label}
        {required ? (
          <span className="text-destructive" aria-hidden>
            *
          </span>
        ) : null}
      </Label>
      <div className="flex flex-col gap-1">
        {React.isValidElement<{ id?: string; "aria-invalid"?: boolean }>(
          children,
        )
          ? React.cloneElement(children, {
              id: children.props.id ?? htmlFor,
              "aria-invalid": error ? true : children.props["aria-invalid"],
              ...(error && errorId ? { "aria-describedby": errorId } : {}),
            })
          : children}
        {error ? (
          <p id={errorId} className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export { FormField };
