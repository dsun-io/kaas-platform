"use client";

/**
 * 通用拖拽排序列表（dnd-kit 封装）—— 全项目**唯一**的排序交互实现。
 *
 * 为什么收拢到一处（2026-10-22 用户拍板：所有排序统一拖拽）：
 * 产品图库 / 条款模板 / 报价行 / 订单行 / 单证图片 / 上传队列六处的排序行为
 * 必须完全一致（把手、占位、触屏长按、键盘可达），各写一份必然漂移；
 * 且项目原先的上移/下移按钮与手填 sort_order 数字框对键盘和触屏都不友好，
 * 统一替换。
 *
 * 统一交互规范（改这里 = 改全部六处）：
 * - 拖动**把手**（`SortableGrip`）排序；行内按钮/输入框不受影响
 *   （pointer sensor 有 8px 激活距离，未超过即 click）
 * - 拖起：原位置由 dnd-kit 让位动画实时腾挪，光标跟随浮层；Esc 取消
 * - 触屏：长按 250ms 激活，不与页面滚动抢手势
 * - 键盘：Tab 聚焦把手 → Space/Enter 拾起 → ↑↓ 移动 → Space/Enter 放下 →
 *   Esc 取消（KeyboardSensor；这是去掉箭头按钮后必须保留的兜底，
 *   项目 e2e 的 a11y 用例自动发现新路由，不能在这里丢分）
 * - 屏幕阅读器：dnd-kit 默认 announcement（拾起/移动/放下/取消）自动播报
 *
 * 两种排布（`layout`）：`vertical` 单列列表（多数场景）/ `grid` 卡片墙（产品图库）。
 * 两者共用同一套 sensor、把手与落点映射，只有排序策略与轴限制不同。
 *
 * 持久化不在本组件内：调用方在 `onReorder(next)` 里自己发请求、做乐观更新与
 * 失败回滚——各组件的落库方式不同（产品图 PATCH sort_order、报价行随单保存、
 * 条款模板 PATCH），硬塞进组件只会多一层猜错。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type ScreenReaderInstructions,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { GripVertical } from "lucide-react";

export interface SortableItem {
  /** 稳定唯一 id（跨渲染不变；后端 id 优先，别用数组下标） */
  id: UniqueIdentifier;
}

/** 默认取 id：多数场景就是后端 id（产品图 / 条款模板 / 报价行） */
function defaultGetId<T>(item: T): UniqueIdentifier {
  return (item as SortableItem).id;
}

/**
 * 拖拽落点的纯映射：把 `(activeId, overId)` 翻译成新数组。
 *
 * 抽成纯函数是为了**可精确测试**：jsdom 没有布局，dnd-kit 的碰撞/位移在单测里
 * 算不出真实结果（键盘能起拖，但位移测不准），所以「起拖/取消/禁用」用组件测，
 * 「顺序到底怎么变」在这里逐条钉死（含 active===over、id 不存在等边界）。
 *
 * `getId` 可覆盖：订单明细草稿的主键叫 `key` 而不是 `id`（见 `OrderItemDraft`），
 * 为了让它也能用同一套拖拽而不必改数据模型，这里允许调用方指定取值函数。
 *
 * 返回 `null` 表示顺序不该变（调用方据此跳过落库，避免白跑请求）。
 */
export function reorderById<T>(
  items: T[],
  activeId: UniqueIdentifier,
  overId: UniqueIdentifier,
  getId: (item: T) => UniqueIdentifier = defaultGetId,
): T[] | null {
  if (activeId === overId) return null;
  const from = items.findIndex((it) => getId(it) === activeId);
  const to = items.findIndex((it) => getId(it) === overId);
  if (from < 0 || to < 0 || from === to) return null;
  return arrayMove(items, from, to);
}

interface RowApi {
  /** 行是否正被拖（浮层出现时本体淡出让位） */
  isDragging: boolean;
  disabled: boolean;
  /** dnd-kit activator 属性：**必须**挂到把手这类可聚焦元素上（键盘排序入口） */
  attributes: ReturnType<typeof useSortable>["attributes"];
  listeners: ReturnType<typeof useSortable>["listeners"];
}

const SortableRowContext = createContext<RowApi | null>(null);

/**
 * 拖拽浮层（DragOverlay）里的行**不在**任何 SortableRow 的 Context 内，
 * 但它复用的 renderItem 里可能有 SortableGrip。浮层只负责“跟着光标展示”，
 * 本身不可再被拖动 ⇒ 给一份惰性 RowApi（把手禁用、listeners 空）。
 */
const OVERLAY_ROW: RowApi = {
  isDragging: true,
  disabled: true,
  attributes: {} as RowApi["attributes"],
  listeners: {} as RowApi["listeners"],
};

/** 行内把手：dnd-kit 的激活器（鼠标/触屏/键盘三种 sensor 都认它） */
export function SortableGrip({
  label = "拖动排序",
  className,
  ...rest
}: { label?: string } & HTMLAttributes<HTMLButtonElement>) {
  const row = useContext(SortableRowContext);
  if (!row) {
    // 发生在 SortableList 之外被误用——开发期直接炸，好过静默不可拖
    throw new Error("SortableGrip 必须放在 SortableList 的行内使用");
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={row.disabled}
      className={
        className ??
        "inline-flex h-7 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
      }
      {...row.attributes}
      {...row.listeners}
      {...rest}
    >
      <GripVertical className="h-4 w-4" />
    </button>
  );
}

interface SortableRowProps<T> {
  item: T;
  index: number;
  renderItem: (item: T, index: number, row: RowApi) => ReactNode;
  itemClassName?: string;
  canDrag: (item: T, index: number) => boolean;
  layout: SortableLayout;
  itemAs: SortableItemElement;
  getId: (item: T) => UniqueIdentifier;
}

function SortableRow<T>({
  item,
  index,
  renderItem,
  itemClassName,
  canDrag,
  layout,
  itemAs,
  getId,
}: SortableRowProps<T>) {
  const disabled = !canDrag(item, index);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: getId(item), disabled });

  const style: CSSProperties = {
    // 纵向列表只允许垂直位移（横向漂移由 restrictToVerticalAxis 兜底，这里双保险）；
    // 网格布局必须让 X 也参与，否则换列时卡片会叠在一起
    transform: transform
      ? layout === "grid"
        ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
        : `translate3d(0, ${Math.round(transform.y)}px, 0)`
      : undefined,
    transition,
  };

  const api = useMemo<RowApi>(
    () => ({ isDragging, disabled, attributes, listeners }),
    [isDragging, disabled, attributes, listeners],
  );

  const content = (
    <SortableRowContext.Provider value={api}>
      {renderItem(item, index, api)}
    </SortableRowContext.Provider>
  );

  // 表格里必须是 `<tr>`：包一层 `<div>` 会直接破坏 table 的盒模型（浏览器会把
  // div 提到表格外面），行高/列宽全乱。两个分支各写一次是为了让 ref 的类型对得上。
  if (itemAs === "tr") {
    return (
      <tr
        ref={setNodeRef}
        style={style}
        data-dragging={isDragging || undefined}
        className={itemClassName}
      >
        {content}
      </tr>
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-dragging={isDragging || undefined}
      className={itemClassName}
    >
      {content}
    </div>
  );
}

/**
 * 排布模式：
 * - `vertical`（默认）：单列纵向列表（条款模板、报价行、订单行、单证图片）
 * - `grid`：多列网格（产品图库这种卡片墙）。网格**必须**换策略——
 *   `verticalListSortingStrategy` 假设每项独占一行，用在多列里会让卡片互相叠压。
 */
export type SortableLayout = "vertical" | "grid";

/** 行元素：表格（`<tr>`）或普通块（`<div>`） */
export type SortableItemElement = "div" | "tr";

/**
 * 容器元素：
 * - `div`（默认）：自带一层包裹容器，`className` 生效；
 * - `fragment`：**不生成任何 DOM**，行直接进入父容器。
 *   用于表格 —— 表格已经有 `<tbody>` 了，再套一层 div/tbody 都是错的，
 *   而 Fragment 能让 `<tr>` 正好落在原来的 `<tbody>` 里（此时 `className` 无效）。
 */
export type SortableContainerElement = "div" | "fragment";

export interface SortableListProps<T> {
  items: T[];
  /** 松手后的新顺序（调用方负责落库 / 乐观更新 / 回滚） */
  onReorder: (nextItems: T[]) => void;
  renderItem: (item: T, index: number, row: RowApi) => ReactNode;
  /**
   * 取稳定唯一 id。默认读 `item.id`；主键不叫 `id` 的数据（订单明细草稿叫 `key`）
   * 用它指定，避免为了拖拽去改数据模型。
   */
  getItemId?: (item: T) => UniqueIdentifier;
  /** 拖动时跟随光标的浮层（默认复用 renderItem；大卡片建议裁一个精简版） */
  renderOverlay?: (item: T) => ReactNode;
  itemClassName?: string;
  className?: string;
  /** 某项是否允许拖动（如产品图库的「主图固定首位」） */
  canDrag?: (item: T, index: number) => boolean;
  /** 整表只读（无写权限）⇒ 不挂任何 sensor，把手禁用 */
  disabled?: boolean;
  layout?: SortableLayout;
  itemAs?: SortableItemElement;
  containerAs?: SortableContainerElement;
}

export function SortableList<T>({
  items,
  onReorder,
  renderItem,
  getItemId,
  renderOverlay,
  itemClassName,
  className,
  canDrag,
  disabled = false,
  layout = "vertical",
  itemAs = "div",
  containerAs = "div",
}: SortableListProps<T>) {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const getId = getItemId ?? defaultGetId;
  /**
   * 拖起时那一刻的卡片宽度。
   *
   * 为什么需要：`DragOverlay` 是 `position: fixed` 的独立容器，脱离网格后
   * `w-full` 会变成视口宽度，卡片在光标下会突然被拉宽。网格模式下把原卡片宽度
   * 钉给浮层，拖动过程中尺寸才不会跳。
   */
  const [activeWidth, setActiveWidth] = useState<number | null>(null);

  /**
   * 屏幕阅读器说明要渲染到哪里。
   *
   * dnd-kit 默认把那两段 `display:none` 的说明**内联**渲染在 `DndContext` 里；
   * 表格模式下 `DndContext` 位于 `<tbody>` 内 ⇒ 会产出 `<tbody><div>` 这种
   * 非法嵌套（React 直接告警，浏览器还会把 div 提出表格外）。
   * 因此表格模式把说明 portal 到 `document.body`。
   *
   * 用 state + effect 而不是直接读 `document.body`：服务端渲染时没有 document，
   * 首帧必须与 SSR 一致（内联），挂载后再搬走，避免 hydration 不匹配。
   */
  const [a11yContainer, setA11yContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载后才能读 document.body；首帧必须与 SSR 一致（内联），否则 hydration 不匹配
    setA11yContainer(containerAs === "fragment" ? document.body : null);
  }, [containerAs]);

  const sensors = useSensors(
    // 鼠标：8px 激活距离——小于它算 click，行内按钮/输入不受拖拽影响
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    // 触屏：长按 250ms 激活——避免和上下滚动抢手势
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    // 键盘：Space/Enter 拾起，↑↓ 移动，Esc 取消（去掉箭头按钮后的 a11y 兜底）
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = useMemo(() => items.map((it) => getId(it)), [items, getId]);

  /**
   * 屏幕阅读器文案（dnd-kit 默认是**英文**）。
   *
   * 这个项目是纯中文界面：默认英文播报会让读屏用户听到
   * "To pick up a draggable item, press the space bar." —— 比没有播报更糟，
   * 因为它还占用了唯一的操作说明入口。这里统一换成中文，并带上"第几项"，
   * 因为卡片墙里"往上/往下"说不清，位次才是用户能对上号的信息。
   */
  const accessibility = useMemo<{
    announcements: Announcements;
    container?: Element;
    screenReaderInstructions: ScreenReaderInstructions;
  }>(() => {
    const positionOf = (id: UniqueIdentifier) => {
      const index = items.findIndex((it) => getId(it) === id);
      return index >= 0 ? index + 1 : 0;
    };
    return {
      ...(a11yContainer ? { container: a11yContainer } : {}),
      screenReaderInstructions: {
        draggable:
          "按空格键或回车键拾起，用方向键移动，再按一次空格键或回车键放下，按 Esc 取消。",
      },
      announcements: {
        onDragStart: ({ active }) => `已拾起第 ${positionOf(active.id)} 项`,
        onDragOver: ({ active, over }) =>
          over
            ? `正在移动到第 ${positionOf(over.id)} 位`
            : `第 ${positionOf(active.id)} 项不在可放置区域`,
        onDragEnd: ({ active, over }) =>
          over
            ? `已放到第 ${positionOf(over.id)} 位`
            : `第 ${positionOf(active.id)} 项已放下`,
        onDragCancel: ({ active }) =>
          `已取消排序，第 ${positionOf(active.id)} 项回到原位`,
      },
    };
  }, [a11yContainer, getId, items]);

  // 整表只读时逐行也禁（把手同步禁用），别只靠 sensors=[]——视觉与语义要一致
  const resolvedCanDrag = useCallback(
    (item: T, index: number) => !disabled && (canDrag ? canDrag(item, index) : true),
    [canDrag, disabled],
  );
  const activeIndex = useMemo(
    () => items.findIndex((it) => getId(it) === activeId),
    [getId, items, activeId],
  );
  const activeItem = activeIndex >= 0 ? items[activeIndex]! : null;

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      setActiveId(event.active.id);
      if (layout === "grid") {
        setActiveWidth(event.active.rect.current.initial?.width ?? null);
      }
    },
    [layout],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      setActiveWidth(null);
      const { active, over } = event;
      if (!over) return;
      const next = reorderById(items, active.id, over.id, getId);
      if (next) onReorder(next);
    },
    [getId, items, onReorder],
  );

  const onDragCancel = useCallback(() => {
    setActiveId(null);
    setActiveWidth(null);
  }, []);

  const rows = items.map((item, index) => (
    <SortableRow
      key={getId(item)}
      item={item}
      index={index}
      renderItem={renderItem}
      itemClassName={itemClassName}
      canDrag={resolvedCanDrag}
      layout={layout}
      itemAs={itemAs}
      getId={getId}
    />
  ));

  return (
    <DndContext
      sensors={disabled ? [] : sensors}
      collisionDetection={closestCenter}
      accessibility={accessibility}
      modifiers={
        layout === "grid"
          ? // 网格里横向位移是正常操作，不能锁轴；仍限制在列表容器内，别拖出可视区
            [restrictToParentElement]
          : [restrictToVerticalAxis, restrictToParentElement]
      }
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <SortableContext
        items={ids}
        strategy={layout === "grid" ? rectSortingStrategy : verticalListSortingStrategy}
      >
        {containerAs === "fragment" ? (
          // 表格模式：行直接落进调用方已有的 <tbody>，这里不能有任何包裹元素
          <>{rows}</>
        ) : (
          <div className={className}>{rows}</div>
        )}
      </SortableContext>
      <DragOverlay style={activeWidth ? { width: activeWidth } : undefined}>
        {activeItem ? (
          <SortableRowContext.Provider value={OVERLAY_ROW}>
            {renderOverlay
              ? renderOverlay(activeItem)
              : renderItem(activeItem, activeIndex, OVERLAY_ROW)}
          </SortableRowContext.Provider>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
