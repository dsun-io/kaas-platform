"use client";

/**
 * 业务客户选择器 —— 报价 / 订单 / 单证 **三处共用的唯一客户入口**。
 *
 * 为什么必须是"选已有客户"而不是自由文本或 URL 参数：
 *   三张单据表的 `customer_id` 都是指向 `customers` 的外键，
 *   后端还会校验"存在、未软删、属本团队"。手输的字符串既过不了闸门，
 *   也会让客户页的「往来记录」树把单据挂到不存在的节点上。
 *   因此这里的选择结果只可能是"客户列表里真实存在的一行"。
 *
 * 为什么自己写一个下拉而不是用 ui/select：
 *   客户是主数据、可能有几百条，必须**可搜索**（服务端 `q`）并能显示条数；
 *   ui/select 只做枚举选择。这里用 Input + 绝对定位面板实现，
 *   不引入任何新依赖。
 *
 * 内联新建（UNCERTAIN #21 口径）：搜不到客户时**就地新建**——
 * 只需公司名（POST /customers 最小契约），建完即选中并回写开单快照，
 * 不再要求用户跳去「客户管理」页打断开单流程。
 *
 * 失败降级：客户列表读不到时，面板里给出"加载失败 + 重试"，
 * 组件本身不抛错、不阻断表单的其它字段。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ErrorState } from "@/components/shared/error-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalizeApiError } from "@/lib/api/api-error";
import { cn } from "@/lib/utils";
import { apiClient } from "@/lib/api/client";
import {
  customerOptionName,
  useCustomerName,
  useCustomerSearch,
} from "@/lib/workstation/use-upstream";

/** 选中的客户：id 用字符串保存（DOM/URL 友好），name 是**开单快照**的来源。 */
export interface CustomerPickerValue {
  id: string;
  name: string;
}

interface CustomerPickerProps {
  value: CustomerPickerValue | null;
  onChange: (next: CustomerPickerValue | null) => void;
  /** 非空即视为"当前有校验错误"（例如提交时没选客户），在下方红字提示 */
  error?: string | null;
  label?: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** 是否显示"必选"星号 */
  required?: boolean;
}

export function CustomerPicker({
  value,
  onChange,
  error = null,
  label = "业务客户",
  hint,
  placeholder = "搜索并选择客户…",
  disabled = false,
  className,
  required = false,
}: CustomerPickerProps) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCountry, setNewCountry] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // 内联新建：POST /customers 最小契约只要 company_name；
  // 建完即选中并刷新搜索缓存，下拉开单流程不中断
  const createCustomer = useMutation({
    mutationFn: async (body: { company_name: string; country?: string }) => {
      const { data } = await apiClient.post<{
        id: number | string;
        company_name?: string | null;
        name?: string | null;
      }>("/customers", body);
      return data;
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["upstream", "customers"] });
      const name = created.company_name || created.name || newName.trim();
      onChange({ id: String(created.id), name });
      toast.success(`已新建客户「${name}」`);
      setCreating(false);
      setNewName("");
      setNewCountry("");
      setOpen(false);
      setKeyword("");
    },
    onError: () => {
      toast.error("新建客户失败，请稍后重试");
    },
  });

  // 防抖：客户列表是服务端搜索，每敲一个字就发一次请求会把接口打满
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword), 250);
    return () => clearTimeout(timer);
  }, [keyword]);

  // 点外面 / 按 Esc 关闭。用 pointerdown 而不是 blur：
  // blur 会在点击列表项之前触发，导致"点不中"。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const root = rootRef.current;
      if (
        root &&
        event.target instanceof Node &&
        !root.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const list = useCustomerSearch(debouncedKeyword);
  const options = useMemo(() => list.data?.items ?? [], [list.data]);

  // 深链（?customer_id=7）只带 id：补一次详情把名字取回来，
  // 否则保存时写进单据的 `customer_name` 快照会是空的
  const needsName = !!value && !value.name;
  const resolved = useCustomerName(needsName ? value.id : null);

  const displayName = value
    ? value.name ||
      (resolved.data && resolved.data !== "" ? resolved.data : "") ||
      `#${value.id}`
    : "";

  const select = (optionId: string, optionName: string) => {
    onChange({ id: String(optionId), name: optionName });
    setOpen(false);
    setKeyword("");
  };

  return (
    <div ref={rootRef} className={cn("relative space-y-1.5", className)}>
      {label && (
        <Label className="text-xs">
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
      )}

      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          className={cn(
            "flex h-8 w-full items-center justify-between gap-2 rounded-lg border bg-background px-3 py-1.5 text-left text-xs transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
            value && !disabled ? "pr-11" : "pr-7",
            error ? "border-destructive" : "border-input",
          )}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value ? displayName : placeholder}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </button>

        {/* 清除按钮放在触发按钮**外面**：button 里再套可点元素是非法嵌套，
            内层控件在部分浏览器里点不动 */}
        {value && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="清除已选客户"
            className="absolute right-6 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={() => onChange(null)}
          >
            <X className="size-3" />
          </span>
        )}
      </div>

      {hint && !error && (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}

      {open && (
        <div className="absolute z-40 mt-1 w-full rounded-lg border bg-popover shadow-md">
          {creating ? (
            <div className="space-y-2 px-3 py-2.5">
              <p className="text-xs font-medium">新建业务客户</p>
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="公司名称（必填）"
                className="h-7 text-xs"
                aria-invalid={createCustomer.isError}
              />
              <Input
                value={newCountry}
                onChange={(e) => setNewCountry(e.target.value)}
                placeholder="国家 / 地区（可选）"
                className="h-7 text-xs"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setCreating(false);
                    setNewName("");
                    setNewCountry("");
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={!newName.trim() || createCustomer.isPending}
                  className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50"
                  onClick={() =>
                    createCustomer.mutate({
                      company_name: newName.trim(),
                      country: newCountry.trim() || undefined,
                    })
                  }
                >
                  {createCustomer.isPending ? "新建中…" : "保存并选用"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
                <Search className="size-3 shrink-0 text-muted-foreground" />
                <Input
                  autoFocus
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="输入客户名称搜索…"
                  className="h-6 border-0 bg-transparent px-0 text-xs focus-visible:ring-0"
                />
              </div>

              <div className="max-h-56 overflow-y-auto py-1" role="listbox">
                {list.isLoading && (
                  <LoadingBlock rows={2} className="px-3 py-2" />
                )}

                {list.isError && (
                  <ErrorState
                    title="客户列表加载失败"
                    message={normalizeApiError(list.error).message}
                    onRetry={() => void list.refetch()}
                    className="m-2"
                  />
                )}

                {!list.isLoading && !list.isError && options.length === 0 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    没有匹配的客户——可以就地新建，或换个关键词。
                  </p>
                )}

                {options.map((option) => {
                  const id = String(option.id);
                  const name = customerOptionName(option);
                  const active = value?.id === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => select(id, name)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted",
                        active && "bg-muted/60 font-medium",
                      )}
                    >
                      <span className="truncate">
                        {name}
                        {option.country && (
                          <span className="ml-1 text-[11px] text-muted-foreground">
                            {option.country}
                          </span>
                        )}
                      </span>
                      {active && <Check className="size-3 shrink-0" />}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center justify-between border-t px-3 py-1.5 text-[11px] text-muted-foreground">
                <span>
                  共 {list.data?.total ?? 0} 个客户
                  {options.length < (list.data?.total ?? 0)
                    ? "（可输入名称缩小范围）"
                    : ""}
                </span>
                <button
                  type="button"
                  className="inline-flex items-center gap-0.5 text-foreground hover:underline"
                  onClick={() => {
                    // 带着搜索词进新建表单：用户打的公司名往往就是要建的名字
                    setNewName(keyword.trim());
                    setCreating(true);
                  }}
                >
                  <Plus className="size-3" />
                  新建客户
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
