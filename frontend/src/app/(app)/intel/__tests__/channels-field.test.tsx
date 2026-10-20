/**
 * A：`GET /intel/channels` 字段错位回归（2026-10-20）
 *
 * 错在哪：后端（`main.py:1024-1040`，列定义 `models.py:1132`）返回的是 `is_enabled`，
 * 前端 `IntelChannel` 却声明/读取 `enabled` ⇒ **free 通道永远显示"未开通"**。
 * 修复口径：前端改读 `is_enabled ?? enabled`（唯一判断入口 `isChannelEnabled()`），
 * 后端不动（DB 列与序列化都是对的，只有前端读错）。
 *
 * 本文件钉两件事：
 * 1. `isChannelEnabled()` 的优先级（后端真源优先于历史字段名）；
 * 2. **渲染结果**：后端形状的数据下 free 通道显示"已开通"（不是只测 helper）。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { isChannelEnabled } from "../hooks/use-intel";

// 只替换数据 hook，保留 `isChannelEnabled` 真实现（渲染断言走真实判断逻辑）
vi.mock("../hooks/use-intel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/use-intel")>();
  return {
    ...actual,
    useIntelChannels: () => ({
      data: {
        free_channels: [
          {
            id: 1,
            name: "海关公开数据",
            type: "customs",
            // 后端真实形状（is_enabled）
            is_enabled: true,
          },
          {
            id: 2,
            name: "地图源渠道",
            type: "maps",
            is_enabled: false,
          },
        ],
        paid_channels: [
          {
            id: 3,
            name: "Panjiva",
            type: "trade",
            is_enabled: false,
            message: "未开通",
          },
        ],
      },
      isLoading: false,
      error: null,
    }),
  };
});

// 必须在 vi.mock 之后导入组件（组件通过被 mock 的模块取数据）
import { ChannelsView } from "../components/channels-view";

describe("isChannelEnabled：以后端 is_enabled 为准，兼容旧 enabled", () => {
  it("后端形状：is_enabled=true 即已开通（free 通道的真实场景）", () => {
    expect(isChannelEnabled({ is_enabled: true })).toBe(true);
    expect(isChannelEnabled({ is_enabled: false })).toBe(false);
  });

  it("兼容旧字段：只有 enabled 时仍可用（旧 mock/中间层）", () => {
    expect(isChannelEnabled({ enabled: true })).toBe(true);
    expect(isChannelEnabled({ enabled: false })).toBe(false);
  });

  it("两者冲突时 is_enabled 优先（旧字段不能翻案）", () => {
    expect(isChannelEnabled({ is_enabled: false, enabled: true })).toBe(false);
    expect(isChannelEnabled({ is_enabled: true, enabled: false })).toBe(true);
  });

  it("缺失字段一律按未开通（不冒充已开通）", () => {
    expect(isChannelEnabled({})).toBe(false);
  });
});

describe("ChannelsView 渲染：后端形状下 free 通道显示「已开通」", () => {
  it("free=已开通 / 未启用=未开通 / paid 显示 message", () => {
    const html = renderToStaticMarkup(createElement(ChannelsView));

    expect(html).toContain("海关公开数据");
    expect(html).toContain("地图源渠道");
    // free 通道 count: 2 个 → 一个已开通、一个未开通；修复前这里会变成两个"未开通"
    expect(html.match(/已开通/g)?.length).toBe(1);
    expect(html.match(/未开通/g)?.length).toBeGreaterThanOrEqual(2);
    // paid 通道展示后端附加的 message
    expect(html).toContain("Panjiva");
    expect(html).toContain("升级订阅后可使用此数据渠道");
  });
});
