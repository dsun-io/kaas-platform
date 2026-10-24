import { describe, expect, it } from "vitest";

import {
  applyNameEnInfo,
  nameEnListFromInfo,
  normalizeNameEnList,
  normalizedInfo,
  primaryNameEnFromInfo,
} from "../product-names";

/**
 * 英文名多值/主名的前端镜像（权威口径在
 * `backend/kaas_common/export_quote/product_names.py`）。
 *
 * 这里钉的是**读形状与搬运**：主名在前、历史单值不能丢、没配英文名时不凭空加键。
 * 内核侧同一组用例在 `backend/worker/tests/test_product_names_en.py`。
 */
describe("产品英文名 · 前端镜像（多值 + 主名）", () => {
  it("去空白、丢空串、大小写不敏感去重且保留首次写法", () => {
    expect(
      normalizeNameEnList([" Chain Link ", "chain link", "", null]),
    ).toEqual(["Chain Link"]);
    expect(normalizeNameEnList("Deer Net")).toEqual(["Deer Net"]);
    expect(normalizeNameEnList(undefined)).toEqual([]);
  });

  it("主名 = 列表第一个；只写主名时插到最前", () => {
    expect(
      nameEnListFromInfo({ name_en_list: ["Cattle Fence", "Field Fence EU"] }),
    ).toEqual(["Cattle Fence", "Field Fence EU"]);
    expect(
      nameEnListFromInfo({
        name_en_primary: "Pasture Fence",
        name_en_list: ["Cattle Fence"],
      }),
    ).toEqual(["Pasture Fence", "Cattle Fence"]);
    expect(primaryNameEnFromInfo({ name_en_list: ["A", "B"] })).toBe("A");
    expect(primaryNameEnFromInfo({})).toBe("");
  });

  it("历史单值 name_en 当成唯一英文名（旧数据不能当没配）", () => {
    expect(nameEnListFromInfo({ name_en: " Deer Net " })).toEqual(["Deer Net"]);
    const out = normalizedInfo({ name_en: "Deer Net", usage: "围栏" });
    expect(out).toEqual({
      name_en: "Deer Net",
      usage: "围栏",
      name_en_list: ["Deer Net"],
      name_en_primary: "Deer Net",
    });
  });

  it("applyNameEnInfo 保留其它键，历史单值跟随主名，清空时两键一致", () => {
    const out = applyNameEnInfo(
      { usage: "围栏", name_en: "Old Name" },
      ["New One", "New Two"],
      "New Two",
    );
    expect(out.name_en_list).toEqual(["New Two", "New One"]);
    expect(out.name_en_primary).toBe("New Two");
    expect(out.usage).toBe("围栏");
    expect(out.name_en).toBe("New Two");
    expect(applyNameEnInfo({}, [])).toEqual({
      name_en_list: [],
      name_en_primary: "",
    });
  });

  it("没配英文名时读投影一个键都不加（旧响应形状不变）", () => {
    expect(normalizedInfo({ usage: "围栏" })).toEqual({ usage: "围栏" });
    expect(normalizedInfo(null)).toEqual({});
    expect(normalizedInfo("not a dict")).toEqual({});
    // 老前端只提交 usage/origin 时也不能凭空加两个空英文名键
    expect(applyNameEnInfo({ usage: "围栏" })).toEqual({ usage: "围栏" });
  });
});
