import { describe, expect, it } from "vitest";
import { isMemberBlogUrl } from "./testimonials";

describe("isMemberBlogUrl", () => {
  it("メンバー本人のブログだけ通す", () => {
    expect(isMemberBlogUrl("https://www.hinatazaka46.com/s/official/diary/detail/66627?ima=0000&cd=member")).toBe(true);
    expect(isMemberBlogUrl("url: https://www.hinatazaka46.com/s/official/diary/detail/66627 [日向坂46]")).toBe(true);
  });
  it("ひなたぼっこ日記やその他の web 資料は通さない", () => {
    expect(isMemberBlogUrl("https://www.hinatazaka46.com/s/official/diary/manager/list?ima=0000#article-68350")).toBe(false);
    expect(isMemberBlogUrl("https://www.hinatazaka46.com/s/official/news/detail/E00000")).toBe(false);
    expect(isMemberBlogUrl(null)).toBe(false);
  });
});
