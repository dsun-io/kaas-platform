/**
 * SortableList（通用拖拽排序）—— 无后端组件测试。
 *
 * 分两层（原因见 `reorderById` 的注释）：
 * 1. **纯函数层**：`reorderById` 把 (activeId, overId) 映射成新顺序 —— 逐条钉死
 *    （前移/后移/同一项/id 不存在），这是「松手后到底怎么排」的真源；
 * 2. **组件层**：渲染、把手可聚焦、键盘 Space 能起拖（`data-dragging` 出现）、
 *    Esc 取消、canDrag=false 与整表 disabled 时把手禁用。
 *    注意 jsdom 没有布局：dnd-kit 的位移/碰撞算不出真实落点，所以这里**不断言**
 *    键盘移动后的最终顺序（那是纯函数层的职责）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  reorderById,
  SortableGrip,
  SortableList,
  type SortableItem,
} from "../sortable-list";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Row = SortableItem & { name: string };

const ROWS: Row[] = [
  { id: "a", name: "第一项" },
  { id: "b", name: "第二项" },
  { id: "c", name: "第三项" },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
}

function unmount() {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
}

/** 统一渲染一个三行列表（行内带把手 + 名称） */
function renderList(props: {
  onReorder?: (next: Row[]) => void;
  canDrag?: (item: Row, index: number) => boolean;
  disabled?: boolean;
}) {
  mount(
    <SortableList<Row>
      items={ROWS}
      onReorder={props.onReorder ?? (() => {})}
      canDrag={props.canDrag}
      disabled={props.disabled}
      renderItem={(item) => (
        <div data-row-content="">
          <SortableGrip />
          <span>{item.name}</span>
        </div>
      )}
    />,
  );
}

function gripOf(name: string): HTMLButtonElement {
  const content = Array.from(
    document.querySelectorAll<HTMLElement>("[data-row-content]"),
  ).find((el) => el.textContent?.includes(name));
  const grip = content?.parentElement?.querySelector<HTMLButtonElement>(
    'button[aria-label="拖动排序"]',
  );
  if (!grip) throw new Error(`没找到「${name}」的拖动把手`);
  return grip;
}

/** dnd-kit 判的是物理码 `event.code`（Space / Escape），只给 key 它不认 */
function keyDown(el: Element, code: string, key: string) {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }),
    );
  });
}

/** 等一个宏任务：KeyboardSensor 的监听是 `setTimeout` 里挂的 */
async function tick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function draggingRows() {
  return document.querySelectorAll("[data-dragging]");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("reorderById（落点映射 · 纯函数）", () => {
  it("往后拖：a → c 得到 b,c,a", () => {
    expect(reorderById(ROWS, "a", "c")?.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("往前拖：c → a 得到 c,a,b", () => {
    expect(reorderById(ROWS, "c", "a")?.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("相邻交换：a ↔ b", () => {
    expect(reorderById(ROWS, "a", "b")?.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("落在自己身上 ⇒ null（不落库，避免白跑请求）", () => {
    expect(reorderById(ROWS, "b", "b")).toBeNull();
  });

  it("id 不在列表里 ⇒ null（防御脏 id，别把数组排乱）", () => {
    expect(reorderById(ROWS, "zzz", "a")).toBeNull();
    expect(reorderById(ROWS, "a", "zzz")).toBeNull();
  });

  it("不改原数组（返回新数组，调用方可以安全地做乐观更新/回滚）", () => {
    const before = ROWS.map((r) => r.id);
    reorderById(ROWS, "a", "c");
    expect(ROWS.map((r) => r.id)).toEqual(before);
  });

  it("数字 id 也认（后端 file_id 场景）", () => {
    const rows = [
      { id: 11, name: "x" },
      { id: 12, name: "y" },
      { id: 13, name: "z" },
    ];
    expect(reorderById(rows, 13, 11)?.map((r) => r.id)).toEqual([13, 11, 12]);
  });
});

describe("SortableList（渲染与状态）", () => {
  it("渲染全部行，把手可聚焦", () => {
    renderList({});
    const text = document.body.textContent ?? "";
    expect(text).toContain("第一项");
    expect(text).toContain("第三项");

    const grips = document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="拖动排序"]',
    );
    expect(grips).toHaveLength(3);
    grips.forEach((g) => expect(g.getAttribute("tabindex")).not.toBe("-1"));
  });

  it("键盘 Space 起拖 ⇒ 该行进入拖动态（data-dragging）", async () => {
    renderList({});
    const grip = gripOf("第一项");
    act(() => grip.focus());
    expect(draggingRows()).toHaveLength(0);

    keyDown(grip, "Space", " ");
    await tick();
    expect(draggingRows().length).toBeGreaterThan(0);
  });

  it("拖起后 Esc 取消 ⇒ 退出拖动态", async () => {
    renderList({});
    const grip = gripOf("第二项");
    act(() => grip.focus());
    keyDown(grip, "Space", " ");
    await tick();
    expect(draggingRows().length).toBeGreaterThan(0);

    keyDown(grip, "Escape", "Escape");
    await tick();
    expect(draggingRows()).toHaveLength(0);
  });

  it("canDrag=false：该行把手禁用，其余行可拖", () => {
    renderList({ canDrag: (_item, index) => index !== 0 });
    expect(gripOf("第一项").disabled).toBe(true);
    expect(gripOf("第二项").disabled).toBe(false);
  });

  it("disabled 整表：所有把手禁用（只读账号不出现可拖假象）", () => {
    renderList({ disabled: true });
    document
      .querySelectorAll<HTMLButtonElement>('button[aria-label="拖动排序"]')
      .forEach((g) => expect(g.disabled).toBe(true));
  });
});
