import { describe, expect, it } from "vitest";

import {
  buildCommitMessage,
  COMMIT_SUBJECT_MAX,
  defaultCommitSubject,
  planPush,
  type RenderedArticle,
} from "./push";

const common = (path: string, githubSha: string | null) => ({
  id: path,
  shortId: path,
  path,
  title: path,
  githubSha,
  updatedAt: new Date("2026-09-15T00:00:00Z"),
});

/** push 可能な記事 (Markdown が組み立っている)。blobSha は判定にしか使わないので適当な文字列でよい */
const base = (over: { path: string; githubSha?: string | null; blobSha?: string }): RenderedArticle => ({
  ...common(over.path, over.githubSha ?? null),
  ok: true,
  markdown: `# ${over.path}`,
  blobSha: over.blobSha ?? `blob-of-${over.path}`,
});

/** 非 public の出典がある記事 (Markdown は無い) */
const blocked = (over: { path: string; githubSha?: string | null }): RenderedArticle => ({
  ...common(over.path, over.githubSha ?? null),
  ok: false,
  blockedSourceNos: [1],
});

describe("planPush", () => {
  it("SHA が一致すれば push 可", () => {
    const tree = new Map([["a.md", "sha-a"]]);
    const plan = planPush([base({ path: "a.md", githubSha: "sha-a" })], tree);
    expect(plan.ok.map((i) => i.article.path)).toEqual(["a.md"]);
    expect(plan.ok[0].isNew).toBe(false);
    expect(plan.blocked).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("上流が変わっていれば衝突 (upstream_changed)", () => {
    const tree = new Map([["a.md", "sha-new"]]);
    const plan = planPush([base({ path: "a.md", githubSha: "sha-old" })], tree);
    expect(plan.ok).toEqual([]);
    expect(plan.conflicts.map((c) => c.reason)).toEqual(["upstream_changed"]);
  });

  it("githubSha が無く上流にファイルがあれば衝突 (not_imported)", () => {
    const tree = new Map([["a.md", "sha-a"]]);
    const plan = planPush([base({ path: "a.md", githubSha: null })], tree);
    expect(plan.conflicts.map((c) => c.reason)).toEqual(["not_imported"]);
  });

  it("githubSha が無く上流にも無ければ新規ファイルとして push 可", () => {
    const plan = planPush([base({ path: "new.md", githubSha: null })], new Map());
    expect(plan.ok.map((i) => i.isNew)).toEqual([true]);
  });

  it("取り込み済みなのに上流に無ければ衝突 (deleted_upstream)", () => {
    const plan = planPush([base({ path: "gone.md", githubSha: "sha-x" })], new Map());
    expect(plan.conflicts.map((c) => c.reason)).toEqual(["deleted_upstream"]);
  });

  it("非 public の出典がある記事は blocked (衝突が無いとき)", () => {
    const tree = new Map([["a.md", "sha-a"]]);
    const plan = planPush([blocked({ path: "a.md", githubSha: "sha-a" })], tree);
    expect(plan.ok).toEqual([]);
    expect(plan.blocked).toHaveLength(1);
  });

  it("衝突と非 public が重なれば衝突を優先する", () => {
    const tree = new Map([["a.md", "sha-new"]]);
    const plan = planPush([blocked({ path: "a.md", githubSha: "sha-old" })], tree);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.blocked).toEqual([]);
  });

  it("組み立てた Markdown が上流と同じ blob なら unchanged (コミットに載せない)", () => {
    const plan = planPush([base({ path: "a.md", githubSha: "same", blobSha: "same" })], new Map([["a.md", "same"]]));
    expect(plan.ok).toEqual([]);
    expect(plan.unchanged.map((i) => i.article.path)).toEqual(["a.md"]);
  });

  it("blob が同じでも githubSha が違えば衝突 (unchanged が衝突を隠さない)", () => {
    const plan = planPush([base({ path: "a.md", githubSha: "old", blobSha: "same" })], new Map([["a.md", "same"]]));
    expect(plan.unchanged).toEqual([]);
    expect(plan.conflicts.map((c) => c.reason)).toEqual(["upstream_changed"]);
  });

  it("記事ごとに独立して判定する", () => {
    const tree = new Map([
      ["ok.md", "s1"],
      ["conflict.md", "s2-new"],
    ]);
    const plan = planPush(
      [
        base({ path: "ok.md", githubSha: "s1" }),
        base({ path: "conflict.md", githubSha: "s2-old" }),
        base({ path: "new.md", githubSha: null }),
      ],
      tree,
    );
    expect(plan.ok.map((i) => i.article.path)).toEqual(["ok.md", "new.md"]);
    expect(plan.conflicts.map((i) => i.article.path)).toEqual(["conflict.md"]);
  });
});

describe("buildCommitMessage", () => {
  it("一行目が空なら既定の件名。本文に path を昇順で並べる", () => {
    expect(buildCommitMessage("", ["b.md", "a.md"])).toBe(`${defaultCommitSubject(2)}\n\na.md\nb.md\n`);
    expect(buildCommitMessage(undefined, ["a.md"])).toBe(`${defaultCommitSubject(1)}\n\na.md\n`);
  });

  it("一行目を上書きできる。絵文字プレフィックスが無ければ補う", () => {
    expect(buildCommitMessage("記事を直した", ["a.md"])).toBe(":dog2: 記事を直した\n\na.md\n");
    expect(buildCommitMessage(":fish: 誤字修正", ["a.md"])).toBe(":fish: 誤字修正\n\na.md\n");
  });

  it("複数行が渡されても一行目だけを使う。空白だけなら既定", () => {
    expect(buildCommitMessage(":fish: 一行目\n二行目", ["a.md"])).toBe(":fish: 一行目\n\na.md\n");
    expect(buildCommitMessage("  \n\n", ["a.md"])).toBe(`${defaultCommitSubject(1)}\n\na.md\n`);
  });

  it("長すぎる一行目は切る (クライアント由来なので長さを信用しない)", () => {
    const long = ":fish: " + "あ".repeat(500);
    const line = buildCommitMessage(long, ["a.md"]).split("\n")[0];
    expect(line.length).toBe(COMMIT_SUBJECT_MAX);
    expect(line.endsWith("…")).toBe(true);
  });
});
