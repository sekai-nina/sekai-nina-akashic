import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ entity: vi.fn() }));
vi.mock("./coverage-items", () => ({ getNinaEntity: mocks.entity }));

import { refreshNinaMentions } from "./nina-mentions";

function fakeDb(matched: string[], current: string[]) {
  return {
    $queryRaw: vi.fn().mockResolvedValue(matched.map((assetId) => ({ assetId }))),
    $executeRaw: vi.fn().mockResolvedValue(0),
    asset: { findMany: vi.fn().mockResolvedValue(current.map((id) => ({ id }))) },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.entity.mockResolvedValue({ id: "nina", terms: ["坂井新奈", "にいな"] });
});

describe("新奈への言及の付け直し", () => {
  it("一致したのに付いていないものを付け、一致しなくなったものを外す", async () => {
    const db = fakeDb(["a", "b"], ["b", "c"]);
    const result = await refreshNinaMentions(db as never, { apply: true });
    expect(result).toMatchObject({ matched: 2, added: ["a"], removed: ["c"] });
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    // 1 回目が付ける (true)、2 回目が外す (false)
    expect(db.$executeRaw.mock.calls[0]).toContain(true);
    expect(db.$executeRaw.mock.calls[0]).toContainEqual(["a"]);
    expect(db.$executeRaw.mock.calls[1]).toContain(false);
    expect(db.$executeRaw.mock.calls[1]).toContainEqual(["c"]);
  });
  it("下見では書き込まない", async () => {
    const db = fakeDb(["a"], []);
    expect((await refreshNinaMentions(db as never, { apply: false })).added).toEqual(["a"]);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
  it("差分が無ければ書き込まない", async () => {
    const db = fakeDb(["a"], ["a"]);
    await refreshNinaMentions(db as never, { apply: true });
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
  it("検索が 0 件なのに印が付いていれば、検索の故障とみなして外さない", async () => {
    const db = fakeDb([], ["a", "b"]);
    await expect(refreshNinaMentions(db as never, { apply: true })).rejects.toThrow();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
  it("エンティティが引けないときは全件を外さずに止める", async () => {
    mocks.entity.mockResolvedValue(null);
    const db = fakeDb([], ["a"]);
    await expect(refreshNinaMentions(db as never, { apply: true })).rejects.toThrow();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});
