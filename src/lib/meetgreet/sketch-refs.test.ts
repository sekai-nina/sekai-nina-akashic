import { describe, expect, it } from "vitest";

import { isRefKeyOf, refPrefix, refsFromJson } from "./sketch-refs";

describe("refsFromJson", () => {
  it("壊れているものは落として、生成を止めない", () => {
    const refs = refsFromJson([
      { key: "meetgreet/a/refs/1.webp", name: "スカート.jpg" },
      { key: "", name: "空" },
      { name: "key が無い" },
      "文字列",
      null,
    ]);
    expect(refs).toEqual([{ key: "meetgreet/a/refs/1.webp", name: "スカート.jpg" }]);
  });

  it("name が無ければ key で代用する (名前欄が空にならない)", () => {
    expect(refsFromJson([{ key: "k" }])).toEqual([{ key: "k", name: "k" }]);
  });

  it("Json 列がオブジェクト・null でも落ちない", () => {
    expect(refsFromJson(null)).toEqual([]);
    expect(refsFromJson({})).toEqual([]);
    expect(refsFromJson("[]")).toEqual([]);
  });
});

describe("isRefKeyOf", () => {
  it("その回の置き場の key だけ通す", () => {
    expect(isRefKeyOf("mg1", `${refPrefix("mg1")}/1.webp`)).toBe(true);
  });

  it("他の回・無関係な R2 オブジェクトは弾く", () => {
    // **ここが緩むと、見えないはずの画像を外部 AI に送る口になる**
    expect(isRefKeyOf("mg1", `${refPrefix("mg2")}/1.webp`)).toBe(false);
    expect(isRefKeyOf("mg1", "meetgreet/style-reference/base.png")).toBe(false);
    expect(isRefKeyOf("mg1", "dossiers/x/y/image.webp")).toBe(false);
    // 前方一致だけで通さない (mg10 の置き場を mg1 のものと誤認しない)
    expect(isRefKeyOf("mg1", "meetgreet/mg10/refs/1.webp")).toBe(false);
  });
});
