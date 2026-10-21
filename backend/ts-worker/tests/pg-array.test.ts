import { describe, expect, it } from "vitest";
import { pgTextArray } from "../src/pg-array";

describe("pgTextArray（fetch_types:false 下的数组字面量编码）", () => {
  it("普通值编成 {a,b}", () => {
    expect(pgTextArray(["customers:read", "quotes:calc"])).toBe('{"customers:read","quotes:calc"}');
  });
  it("空数组编成 {}", () => {
    expect(pgTextArray([])).toBe("{}");
  });
  it("引号与反斜杠转义", () => {
    expect(pgTextArray(["a\"b", "c\\d"])).toBe('{"a\\"b","c\\\\d"}');
  });
});
