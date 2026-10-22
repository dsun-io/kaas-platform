/**
 * U-P0B5：6 个段级 error.tsx / loading.tsx 的统一边界。
 *
 * 钉死两件事：
 * 1. 错误分支**保留页头**（错误页也必须有唯一 h1，不能只剩一行红字/裸 h2 + button）；
 * 2. 错误正文走共享 ErrorState（role="alert" + reset 重试），点重试调 Next 的 reset；
 * 3. 加载分支同样有页头（静态导出首帧也有 h1，e2e a11y 不因加载态丢标题）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import DashboardError from "../dashboard/error";
import DashboardLoading from "../dashboard/loading";
import EventsError from "../events/error";
import EventsLoading from "../events/loading";
import KbError from "../kb/error";
import KbLoading from "../kb/loading";
import AuditLogError from "../audit-log/error";
import AuditLogLoading from "../audit-log/loading";
import SettingsError from "../settings/error";
import SettingsLoading from "../settings/loading";
import GrayReleaseError from "../admin/gray-release/error";
import GrayReleaseLoading from "../admin/gray-release/loading";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

const ERROR_CASES: {
  name: string;
  Component: React.ComponentType<ErrorProps>;
  title: string;
}[] = [
  { name: "dashboard", Component: DashboardError, title: "仪表盘" },
  { name: "events", Component: EventsError, title: "事件审计" },
  { name: "kb", Component: KbError, title: "知识库管理" },
  { name: "audit-log", Component: AuditLogError, title: "操作日志" },
  { name: "settings", Component: SettingsError, title: "系统设置" },
  { name: "gray-release", Component: GrayReleaseError, title: "灰度发布" },
];

const LOADING_CASES: {
  name: string;
  Component: React.ComponentType;
  title: string;
}[] = [
  { name: "dashboard", Component: DashboardLoading, title: "仪表盘" },
  { name: "events", Component: EventsLoading, title: "事件审计" },
  { name: "kb", Component: KbLoading, title: "知识库管理" },
  { name: "audit-log", Component: AuditLogLoading, title: "操作日志" },
  { name: "settings", Component: SettingsLoading, title: "系统设置" },
  { name: "gray-release", Component: GrayReleaseLoading, title: "灰度发布" },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
  container = null;
});

describe("段级 error.tsx（U-P0B5）", () => {
  for (const { name, Component, title } of ERROR_CASES) {
    it(`${name}: 保留页头 + role=alert + 重试调 reset`, () => {
      const reset = vi.fn();
      mount(
        <Component
          error={Object.assign(new Error("后端 500"), { digest: "d1" })}
          reset={reset}
        />,
      );

      const headings = container!.querySelectorAll("h1");
      expect(headings.length).toBe(1);
      expect(headings[0]?.textContent).toBe(title);

      const alert = container!.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain("后端 500");

      const retry = Array.from(container!.querySelectorAll("button")).find(
        (b) => (b.textContent ?? "").trim() === "重试",
      );
      expect(retry).toBeDefined();
      act(() => {
        retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(reset).toHaveBeenCalledTimes(1);
    });
  }

  it("error 无 message 时给中文兜底文案（不出现空白原因）", () => {
    mount(<DashboardError error={new Error()} reset={() => {}} />);
    const alert = container!.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("后端忙碌或网络异常");
  });
});

describe("段级 loading.tsx（U-P0B5）", () => {
  for (const { name, Component, title } of LOADING_CASES) {
    it(`${name}: 加载态也有唯一页头 + 骨架`, () => {
      mount(<Component />);

      const headings = container!.querySelectorAll("h1");
      expect(headings.length).toBe(1);
      expect(headings[0]?.textContent).toBe(title);
      expect(
        container!.querySelectorAll('[data-slot="skeleton"]').length,
      ).toBeGreaterThan(0);
      // 加载不是错误：不能出现 alert
      expect(container!.querySelector('[role="alert"]')).toBeNull();
    });
  }
});
