import { describe, expect, it } from "vitest";

import {
  auditFootnotes,
  footnoteRefsInBody,
  parseBodySegments,
  wikiLinkTargetsInBody,
} from "./footnotes";

const NO_LINKS = new Map<string, string>();
const split = (body: string, known: Set<number>) => parseBodySegments(body, known, NO_LINKS);

describe("footnoteRefsInBody", () => {
  it("出現順・重複なしで拾う", () => {
    expect(footnoteRefsInBody("A^[2] B^[1] C^[2]")).toEqual([2, 1]);
  });

  it("脚注が無ければ空", () => {
    expect(footnoteRefsInBody("脚注のない本文")).toEqual([]);
  });

  it("2 桁以上も拾う", () => {
    expect(footnoteRefsInBody("A^[13]")).toEqual([13]);
  });

  it("似た記法を誤検出しない", () => {
    // 配列の添字や単なる括弧を脚注と誤認しない
    expect(footnoteRefsInBody("arr[1] ^[a] ^[] x")).toEqual([]);
  });
});

describe("parseBodySegments (脚注)", () => {
  it("本文を素のテキストと脚注に分ける", () => {
    expect(split("前^[1]後", new Set([1]))).toEqual([
      { kind: "text", text: "前" },
      { kind: "footnote", num: 1, known: true },
      { kind: "text", text: "後" },
    ]);
  });

  it("対応する出典が無い脚注に印を付ける", () => {
    expect(split("x^[9]", new Set([1]))).toEqual([
      { kind: "text", text: "x" },
      { kind: "footnote", num: 9, known: false },
    ]);
  });

  it("脚注が先頭・末尾でも欠けない", () => {
    expect(split("^[1]", new Set([1]))).toEqual([
      { kind: "footnote", num: 1, known: true },
    ]);
  });

  it("分解しても元の本文に戻せる", () => {
    const body = "- 口をすぼめる^[1]\n\t- 肩を組む^[2]^[3]\n";
    const joined = split(body, new Set([1, 2, 3]))
      .map((s) => {
        if (s.kind === "text") return s.text;
        if (s.kind === "footnote") return `^[${s.num}]`;
        return `[[${s.label}]]`;
      })
      .join("");
    expect(joined).toBe(body);
  });
});

describe("auditFootnotes", () => {
  it("対応が取れていれば何も出さない", () => {
    expect(auditFootnotes("A^[1] B^[2]", [1, 2])).toMatchObject({
      missingSources: [],
      unreferenced: [],
    });
  });

  it("本文が存在しない出典を指していたら出す", () => {
    expect(auditFootnotes("A^[3]", [1]).missingSources).toEqual([3]);
  });

  it("どこからも参照されていない出典を出す", () => {
    expect(auditFootnotes("A^[1]", [1, 2, 3]).unreferenced).toEqual([2, 3]);
  });

  it("番号の無い出典は未参照として数えない", () => {
    // akashic 側で足した紐づけは frontmatter の source[] に載らないので
    // 本文から参照されていなくて当然
    expect(auditFootnotes("A^[1]", [1, null, null]).unreferenced).toEqual([]);
  });

  it("本文に脚注が 1 つも無ければ未参照を出さない", () => {
    // 記事全体がその出典から来ている形 (quote 記事はほぼこれ)。
    // ここを出すと 76 本が警告だらけになり、本物の取りこぼし 11 本が埋もれる
    expect(auditFootnotes("引用だけの本文", [1]).unreferenced).toEqual([]);
  });

  it("脚注を使っている記事なら未参照を出す", () => {
    expect(auditFootnotes("A^[1]", [1, 2]).unreferenced).toEqual([2]);
  });

  it("同じ番号の出典が重複していても 1 件として扱う", () => {
    expect(auditFootnotes("A^[1]", [1, 1]).unreferenced).toEqual([]);
  });
});

describe("記事間リンク", () => {
  const links = new Map([["お披露目での自己紹介", "abc1234"]]);

  it("[[タイトル]] を解決してリンクにする", () => {
    expect(parseBodySegments("初出は[[お披露目での自己紹介]]である", new Set(), links)).toEqual([
      { kind: "text", text: "初出は" },
      { kind: "link", label: "お披露目での自己紹介", shortId: "abc1234" },
      { kind: "text", text: "である" },
    ]);
  });

  it("[[タイトル|表示名]] は表示名を使う", () => {
    expect(parseBodySegments("[[お披露目での自己紹介|あの日]]", new Set(), links)).toEqual([
      { kind: "link", label: "あの日", shortId: "abc1234" },
    ]);
  });

  it("解決できないリンクはそのまま出す", () => {
    expect(parseBodySegments("[[存在しない記事]]", new Set(), links)).toEqual([
      { kind: "deadLink", label: "存在しない記事", target: "存在しない記事" },
    ]);
  });

  it("脚注と記事間リンクが混在しても位置順に分解する", () => {
    const segs = parseBodySegments("A^[1]B[[お披露目での自己紹介]]C", new Set([1]), links);
    expect(segs.map((s) => s.kind)).toEqual(["text", "footnote", "text", "link", "text"]);
  });

  it("wikiLinkTargetsInBody は出現順・重複なしで返す", () => {
    expect(wikiLinkTargetsInBody("[[B]] [[A]] [[B]]")).toEqual(["B", "A"]);
  });

  it("[[3]] は脚注の書き間違いとして拾う", () => {
    // 実データで 1 記事 6 箇所。その記事の「未参照の出典」の正体がこれだった
    const r = auditFootnotes("A[[3]]B[[4]]", [3, 4]);
    expect(r.numericWikiLinks).toEqual([3, 4]);
    // 書き間違いを参照とみなすので未参照にはしない
    expect(r.unreferenced).toEqual([]);
  });

  it("解決できないリンクを列挙する", () => {
    const r = auditFootnotes("[[ある記事]] [[ない記事]]", [], new Set(["ある記事"]));
    expect(r.brokenLinks).toEqual(["ない記事"]);
  });
});

describe("Obsidian のエスケープされたパイプ", () => {
  const links = new Map([["ハリー・ポッターが好き", "abc1234"]]);

  it("テーブル内の [[題\\|表示]] を解決する", () => {
    // Obsidian は Markdown テーブル内で | を \| にエスケープする。
    // 宛先の末尾に \ が残ると実在する記事に解決できず、偽の broken 警告になる
    const segs = parseBodySegments("| [[ハリー・ポッターが好き\\|ハリー・ポッター]] |", new Set(), links);
    expect(segs).toContainEqual({ kind: "link", label: "ハリー・ポッター", shortId: "abc1234" });
  });

  it("エスケープされていても broken 扱いにしない", () => {
    const r = auditFootnotes("[[ハリー・ポッターが好き\\|ハリー・ポッター]]", [], new Set(["ハリー・ポッターが好き"]));
    expect(r.brokenLinks).toEqual([]);
  });
});
