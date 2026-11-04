import { describe, expect, it } from "vitest";
import { buildSnippets, MAX_SNIPPET_CHARS } from "./snippets";

describe("buildSnippets", () => {
  it("離れた一致は別々の抜粋にして、すべて数える", () => {
    const text = `美月とドバイチョコのかき氷${"あ".repeat(700)}寒天にドバイチョコもち`;
    const { snippets, matchCount } = buildSnippets(text, ["ドバイチョコ"]);
    expect(matchCount).toBe(2);
    expect(snippets).toHaveLength(2);
    expect(snippets[0]).toContain("かき氷");
    expect(snippets[1]).toContain("寒天に");
  });

  it("近い一致は 1 つの抜粋にまとめる", () => {
    const { snippets, matchCount } = buildSnippets("チョコとチョコ", ["チョコ"]);
    expect(matchCount).toBe(2);
    expect(snippets).toEqual(["チョコとチョコ"]);
  });

  it("頻出語でも抜粋は上限で切り、一致数は本文全体を数える", () => {
    const text = "の".repeat(5000);
    const { snippets, matchCount } = buildSnippets(text, ["の"]);
    expect(matchCount).toBe(5000);
    expect(snippets.join("").replaceAll("…", "").length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
  });

  it("生の本文に一致が無ければ先頭を返す", () => {
    expect(buildSnippets("本文", ["無い語"])).toEqual({ snippets: ["本文"], matchCount: 0 });
  });
});
