/**
 * `product_photos` 字段的**纯文本 ↔ 结构**转换（纯函数，无 React 依赖）。
 *
 * 为什么单独成文件：这个字段在表单里是用户可手改的 **JSON 文本框**，
 * 所有改动（加图/重排/移除）都要"读文本 → 改结构 → 写回文本"。
 * 这套逻辑放进组件里会有两个后果：
 *  · 无法精确测试（要挂整个 DocCustomForm、mock 一堆接口）；
 *  · 容易在某个分支上把用户手写的额外字段吃掉，而没人发现。
 *
 * 三条不可退让的约束：
 * 1. **只重排、不重建**：条目对象原样搬运，`caption` 之外的字段（例如历史数据里的
 *    `image`、用户手写的 `note`）必须原封不动。
 * 2. **认不出来就不动**：数组里存在没有 `file_id` 的条目时，重排直接放弃
 *    （宁可这次拖拽没生效，也不能把用户写的条目静默丢掉）。
 * 3. **解析失败不抛**：用户正在手改 JSON 时，界面必须还能渲染，只是列表为空。
 */

/** 单据里已引用的一张产品图（`product_photos` 的一个条目） */
export interface PickedPhoto {
  file_id: number;
  /** 出图时的图注；空串 = 该条目没写 caption */
  caption: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 读数组：非数组 / 解析失败一律当作空（用户可能正在手改） */
function readArray(raw: string | undefined): unknown[] | null {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 从文本里取出可展示的条目（顺序 = 出图顺序）；无法识别的条目跳过但不影响其它条目 */
export function parsePhotoEntries(raw: string | undefined): PickedPhoto[] {
  const arr = readArray(raw);
  if (!arr) return [];
  return arr.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.file_id !== "number") return [];
    return [
      {
        file_id: entry.file_id,
        caption: typeof entry.caption === "string" ? entry.caption : "",
      },
    ];
  });
}

/**
 * 按新顺序写回文本。
 *
 * 返回 `null` = 不该改（解析失败、或存在无法识别的条目）——调用方据此提示用户
 * 而不是静默写入。返回字符串 = 新的 JSON 文本（2 空格缩进，便于人工核对）。
 */
export function reorderPhotoEntries(
  raw: string | undefined,
  nextOrder: PickedPhoto[],
): string | null {
  const arr = readArray(raw);
  if (!arr) return null;

  const byId = new Map<number, unknown>();
  for (const entry of arr) {
    if (!isRecord(entry) || typeof entry.file_id !== "number") continue;
    if (!byId.has(entry.file_id)) byId.set(entry.file_id, entry);
  }

  const rebuilt = nextOrder
    .map((photo) => byId.get(photo.file_id))
    .filter((entry): entry is unknown => entry !== undefined);

  // 数量对不上 ⇒ 有认不出来的条目；此时重排会让它们消失，宁可放弃
  if (rebuilt.length !== arr.length) return null;
  return JSON.stringify(rebuilt, null, 2);
}

/** 移除一条引用。返回 `null` = 解析失败（调用方提示）；
 * 返回空串 = 已经没有引用了（字段清空，而不是留一个 `[]`）。
 */
export function removePhotoEntry(
  raw: string | undefined,
  fileId: number,
): string | null {
  const arr = readArray(raw);
  if (!arr) return null;
  const kept = arr.filter(
    (entry) => !(isRecord(entry) && entry.file_id === fileId),
  );
  return kept.length === 0 ? "" : JSON.stringify(kept, null, 2);
}
