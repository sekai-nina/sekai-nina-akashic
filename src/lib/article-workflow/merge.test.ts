import { describe, expect, it } from "vitest";
import { checkMerge, finalizeMerge, mergePrompt, renumberMaterials, unwrapFence } from "./merge";
import type { RenderedSource } from "./render";

const base = `坂井新奈は祖母と仲が良い。

- 幼い頃はよく祖母の家に泊まっていた^[1]
- オーディション前に応援の手紙をもらった^[2]
`;

describe("checkMerge", () => {
  it("行の差し込みと、既存の行の末尾への ^[n] の追加は通す", () => {
    const proposed = `坂井新奈は祖母と仲が良い。

- 幼い頃はよく祖母の家に泊まっていた^[1]
\t- 祖母から料理を教わったこともある^[3]
- オーディション前に応援の手紙をもらった^[2]^[3]
- 今も月に一度は電話している^[4]
`;
    const r = checkMerge(base, proposed);
    expect(r).toEqual({ ok: true, changedLines: [3, 4, 5] });
  });

  it("何も変えていない案は変化なしで通す", () => {
    expect(checkMerge(base, base)).toEqual({ ok: true, changedLines: [] });
  });

  it("空行を足すのと行末の空白は気にしない", () => {
    const proposed = "坂井新奈は祖母と仲が良い。  \n\n\n- 幼い頃はよく祖母の家に泊まっていた^[1]\n\n- オーディション前に応援の手紙をもらった^[2]";
    expect(checkMerge(base, proposed)).toEqual({ ok: true, changedLines: [] });
  });

  it("段落の区切りの空行を消すのは弾く (前後の段落が繋がる)", () => {
    const r = checkMerge(base, base.replace("仲が良い。\n\n", "仲が良い。\n"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("段落の区切り");
  });

  it("既存の行の書き換えは弾く", () => {
    const proposed = base.replace("仲が良い。", "とても仲が良い。");
    const r = checkMerge(base, proposed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("坂井新奈は祖母と仲が良い。");
  });

  it("既存の行の削除・並べ替えは弾く", () => {
    expect(checkMerge(base, base.replace("- オーディション前に応援の手紙をもらった^[2]\n", "")).ok).toBe(false);
    const swapped = `坂井新奈は祖母と仲が良い。

- オーディション前に応援の手紙をもらった^[2]
- 幼い頃はよく祖母の家に泊まっていた^[1]
`;
    expect(checkMerge(base, swapped).ok).toBe(false);
  });

  it("行の途中への ^[n] の挿入・末尾への文の追加は書き換えとして弾く", () => {
    expect(checkMerge(base, base.replace("泊まっていた^[1]", "泊まっていた^[3]^[1]")).ok).toBe(false);
    expect(checkMerge(base, base.replace("泊まっていた^[1]", "泊まっていた^[1]。夏休みは毎年")).ok).toBe(false);
  });
});

describe("renumberMaterials", () => {
  const materials = `# ドシエ「祖母」の素材

### ^[1] 坂井新奈ブログ「夏」（2026-08-01）
URL: https://example.com/1

本文:
夏の話

### ^[2] Talk 2026.10.1（2026-10-01）

本文:
おばあちゃんの話
`;

  it("組み立ての番号を記事の番号に付け替え、新しい素材に印を付けて番号順に並べる", () => {
    const r = renumberMaterials(materials, new Map([[1, 5], [2, 3]]), new Set([5]));
    expect(r.text).toContain("### ^[3] Talk 2026.10.1");
    expect(r.text).toContain("### ^[5] 【新しい素材】坂井新奈ブログ「夏」");
    expect(r.text.indexOf("^[3]")).toBeLessThan(r.text.indexOf("^[5]"));
    // 画面に出す節は新しい素材だけ (既存の出典の中身は buildMaterialsText の focus で落とす)
    expect(r.sections.map((s) => s.no)).toEqual([5]);
    expect(r.text.startsWith("# ドシエ「祖母」の素材")).toBe(true);
  });

  it("記事に載らない出典の節は落とす", () => {
    const r = renumberMaterials(materials, new Map([[2, 3]]), new Set([3]));
    expect(r.text).not.toContain("夏の話");
    expect(r.sections).toHaveLength(1);
  });
});

describe("mergePrompt", () => {
  it("既存の本文・素材・新しい出典の番号をユーザーメッセージに入れ、システムプロンプトはそのまま使う", () => {
    const p = mergePrompt({
      system: ["鉄則"],
      title: "祖母",
      existingBody: base,
      materials: "# 素材",
      newSources: [{ sourceNo: 3, label: "Talk" }],
      included: 2,
      truncated: 0,
    });
    expect(p.system).toEqual(["鉄則"]);
    expect(p.user).toContain("記事のタイトル: 祖母");
    expect(p.user).toContain("- 幼い頃はよく祖母の家に泊まっていた^[1]");
    expect(p.user).toContain("^[3] Talk");
    expect(p.included).toBe(2);
  });
});

describe("unwrapFence", () => {
  it("AI が本文をコードブロックで包んで返したら外す", () => {
    expect(unwrapFence("```markdown\n- 事実^[1]\n```")).toBe("- 事実^[1]\n");
    expect(unwrapFence("- 事実^[1]\n")).toBe("- 事実^[1]\n");
  });
});

describe("finalizeMerge", () => {
  const src = (sourceNo: number, assetId: string): RenderedSource =>
    ({ sourceNo, assetId, label: `出典${assetId}`, url: null, date: null });

  it("本文で使った新しい出典だけ残し、詰めて採番し直す (本文の ^[n] も書き換える)", () => {
    const body = "- 既存^[1]^[2]\n- 新しい事実^[5]\n";
    const r = finalizeMerge(body, [src(3, "a"), src(4, "b"), src(5, "c")], new Set([1, 2]));
    expect(r.body).toBe("- 既存^[1]^[2]\n- 新しい事実^[3]\n");
    expect(r.sources.map((s) => [s.sourceNo, s.assetId])).toEqual([[3, "c"]]);
    expect(r.unused.map((s) => s.assetId)).toEqual(["a", "b"]);
  });

  it("見えない出典の番号でも、もとの本文にあった番号 (keepNos) は残し、その続きから採番する", () => {
    const r = finalizeMerge("- 既存^[1]^[7]\n- 新しい^[2]\n", [src(2, "n")], new Set([1, 7]));
    expect(r.body).toBe("- 既存^[1]^[7]\n- 新しい^[8]\n");
    expect(r.sources.map((s) => s.sourceNo)).toEqual([8]);
  });

  it("どの出典にも当たらない番号の ^[n] は落とす", () => {
    const r = finalizeMerge("- 事実^[9]^[1]\n", [], new Set([1]));
    expect(r.body).toBe("- 事実^[1]\n");
  });

  it("改行コードと行末の空白を揃え、末尾は改行 1 つにする", () => {
    const r = finalizeMerge("- 事実^[1]  \r\n\r\n\r\n", [], new Set([1]));
    expect(r.body).toBe("- 事実^[1]\n");
  });
});
