"use client";

/**
 * 轻量浮层（O5）：一个 trigger 按钮 + 一块非模态面板。
 *
 * 为什么需要（而不是继续用原生 `<details>`）：
 * 原生 details/summary 的键盘与关闭语义不可控 —— 点页面别处不会收起、Esc 也关不掉，
 * 于是各页只能各自补 `document.addEventListener`（orders 列表就这么补过一轮），
 * 每加一个浮层就要再抄一遍"外点关闭 / Esc 关闭 / 焦点归还"。
 * 这里把这三条收成一处，业务只需给 trigger 文案和面板内容。
 *
 * 与 `ui/dropdown-menu` 的分工：
 * - 菜单（单选/复选命令、需要 `role="menu"` 语义）用 ui/dropdown-menu；
 * - **筛选/配置面板**（一坨自定义控件，不是命令列表）用本组件（role="dialog"、非模态）。
 *
 * 行为口径：
 * - trigger：`aria-expanded` / `aria-haspopup="dialog"` / `aria-controls` 自动维护；
 * - **Esc**：收起 + 焦点**还给 trigger**（否则焦点落在已隐藏的控件上）；
 * - **外点**：`mousedown` 收起（用 mousedown 而不是 click —— 点表格行会先触发行的
 *   click 打开详情，浮层应当在那一刻已经收起）；点面板里面不收起；
 * - 受控 / 非受控都支持：传 `open` 即受控（可选 `onOpenChange`）。
 *
 * 不做 portal：面板相对 trigger 定位（`relative` 容器 + `absolute` 面板），
 * 避免静态导出/浮层裁剪场景里的定位闪烁；面板内容由调用方控制高度与滚动。
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface PopoverPanelProps {
  /** trigger 按钮内容（按钮语义由组件提供，不要再套 <button>） */
  trigger: ReactNode;
  /** 面板内容 */
  children: ReactNode;
  /** 面板无障碍名称（role="dialog" 必填，建议与 trigger 文案一致） */
  ariaLabel?: string;
  /** 面板对齐方向（相对 trigger），默认收在右侧（表格工具栏靠右） */
  align?: "start" | "end";
  className?: string;
  triggerClassName?: string;
  panelClassName?: string;
  /** 受控打开状态；不传即非受控 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function PopoverPanel({
  trigger,
  children,
  ariaLabel,
  align = "end",
  className,
  triggerClassName,
  panelClassName,
  open: controlledOpen,
  onOpenChange,
}: PopoverPanelProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const panelId = useId();

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChangeRef.current?.(next);
    },
    [isControlled],
  );

  useEffect(() => {
    if (!open) return;

    const onMouseDown = (event: MouseEvent) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      if (event.target instanceof Node && wrapper.contains(event.target)) {
        return;
      }
      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setOpen]);

  return (
    <div
      ref={wrapperRef}
      data-slot="popover-panel-root"
      className={cn("relative inline-block", className)}
    >
      <button
        ref={triggerRef}
        type="button"
        data-slot="popover-panel-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        className={cn(
          "rounded-md border px-2 py-1.5 text-xs hover:bg-muted",
          triggerClassName,
        )}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label={ariaLabel}
          data-slot="popover-panel"
          className={cn(
            "absolute top-full z-50 mt-1 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg",
            align === "end" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
