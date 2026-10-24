"use client";

/**
 * 产品英文名编辑器（一名多写法 / 主名）。
 *
 * 用户诉求（2026-10-24 生产验收）：一个产品在不同地区叫法不同 ⇒ 英文名要能加多条，
 * 并且能指定**主英文名**（报价 / 订单 / 单证只用主名）。
 *
 * 交互口径：
 * - 列表顺序即主次：**第 1 行是主英文名**（左侧单选按钮可换主名，换完立刻挪到第 1 行）；
 * - 增删都在这里做；空值/重复（大小写不敏感）由保存时统一清掉（内核还会再归一化一次）；
 * - 系统产品（无 tenant_products 行）同样可编辑 —— 英文名存在团队级
 *   `product_profiles.info`，不需要先「按我们的规格自定义」。
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PRIMARY_RADIO_NAME = "product-name-en-primary";

export function NameEnEditor({
  names,
  onChange,
  disabled = false,
}: {
  names: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (names.some((n) => n.trim().toLowerCase() === value.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...names, value]);
    setDraft("");
  };

  const setPrimary = (index: number) => {
    if (index <= 0) return;
    const picked = names[index];
    if (!picked || !picked.trim()) return;
    onChange([picked, ...names.filter((_, i) => i !== index)]);
  };

  const rename = (index: number, value: string) => {
    onChange(names.map((n, i) => (i === index ? value : n)));
  };

  const remove = (index: number) => {
    onChange(names.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">英文名（可多个）</span>
        <span className="text-xs text-muted-foreground">
          第 1 个是主英文名，报价 / 单证用它
        </span>
      </div>

      {names.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          还没有英文名；在下面输入后点「添加」，保存后生效。
        </p>
      ) : (
        <ul className="space-y-1.5">
          {names.map((name, index) => (
            <li key={index} className="flex flex-wrap items-center gap-2">
              <input
                type="radio"
                name={PRIMARY_RADIO_NAME}
                aria-label={`把「${name || "未命名"}」设为主英文名`}
                title="设为主英文名"
                checked={index === 0}
                disabled={disabled}
                onChange={() => setPrimary(index)}
              />
              <Input
                value={name}
                disabled={disabled}
                aria-label={`英文名 ${index + 1}`}
                placeholder="如：Cattle Fence"
                className="h-8 min-w-0 flex-1 text-sm"
                onChange={(e) => rename(index, e.target.value)}
              />
              {index === 0 ? (
                <span className="shrink-0 rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 text-xs text-primary">
                  主英文名
                </span>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">
                  地区别名
                </span>
              )}
              <button
                type="button"
                aria-label={`删除英文名「${name || "未命名"}」`}
                title="删除这条英文名"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                disabled={disabled}
                onClick={() => remove(index)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-1.5">
        <Input
          value={draft}
          disabled={disabled}
          aria-label="新增英文名"
          placeholder="如：欧洲客户叫 Cattle Fence"
          className="h-8 flex-1 text-xs"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 px-2 text-xs"
          disabled={disabled || !draft.trim()}
          onClick={add}
        >
          添加
        </Button>
      </div>
    </div>
  );
}
