/**
 * U-P0B3（审计 §4 K1）：知识库**硬编码假统计下线**的回归测试。
 *
 * 背景：kb/page.tsx 原来写死「知识条目 48 / 产品品类 6 / 最近更新 2 小时前 /
 * 数据源 工位能力网」—— 没有任何接口支撑。现在必须显示**明确「未接入」**，
 * 且不得再出现那组假数字（48 / 2 小时前）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/lib/events/use-page-view", () => ({ usePageView: () => {} }));
vi.mock("@/components/route-guard", () => ({
  RouteGuard: ({ children }: { children: ReactNode }) => children,
}));

import KbPage from "../page";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  client?.clear();
  root = null;
  container = null;
  client = null;
});

describe("知识库页（建设中）", () => {
  it("不再显示硬编码假统计，而是明确「尚未接入」", async () => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <QueryClientProvider client={client!}>
          <KbPage />
        </QueryClientProvider>,
      ),
    );
    await settle();

    const text = container.textContent ?? "";
    // 假统计的数值与来源文案都不许再出现
    // （「知识条目 / 产品品类 / 最近更新」这几个词本身是功能描述，会合法出现在
    //  说明文案里；这里钉死的是那组**假数据**：48 / 6 / 2 小时前 / 工位能力网）
    expect(text).not.toContain("2 小时前");
    expect(text).not.toContain("工位能力网");
    expect(text).not.toContain("48");
    expect(text).not.toContain("数据源");

    // 明确说明"未接入"，而不是用 0 冒充真实数据
    expect(text).toContain("知识库统计尚未接入");
    expect(text).toContain("不显示估算数字");
    expect(text).toContain("建设中");
  });
});
