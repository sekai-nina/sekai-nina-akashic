import { prisma, withClearance } from "@/lib/db";
import { invalidateEntities } from "@/lib/cache";
import { entityClearanceWhere } from "@/lib/domain/entities";
import { normalizeText } from "@/lib/utils";

/**
 * エンティティ名の解決。
 *
 * MCP のクライアントは entityId を持たず名前しか知らないので、名前で受けて
 * 既存エンティティに寄せる。**マッチしなかった名前は既定では作らない** —
 * findOrCreateEntity は canonicalName の完全一致 upsert なので、
 * 「坂井 新奈」のような表記ゆれをそのまま重複エンティティにしてしまう。
 * 呼び出し側が createMissing を明示したときだけ tag として新規作成する
 * (person / place はメンバー同期・聖地登録の管轄なので自動生成しない)。
 */

export interface EntityResolution {
  /** 紐づけに使える解決済みエンティティ */
  resolved: Array<{ id: string; type: string; name: string; inputName: string }>;
  /** 一致するエンティティが無かった入力名 */
  unresolved: string[];
  /** 同名のエンティティが複数の type で見つかった入力名と候補 */
  ambiguous: Array<{
    inputName: string;
    candidates: Array<{ id: string; type: string; name: string }>;
  }>;
  /** createMissing で新規作成した名前 */
  created: string[];
}

export async function resolveEntityNames(
  names: string[],
  options: { createMissing?: boolean; clearance?: string } = {}
): Promise<EntityResolution> {
  const clearance = options.clearance ?? "public";
  const result: EntityResolution = {
    resolved: [],
    unresolved: [],
    ambiguous: [],
    created: [],
  };

  const seen = new Set<string>();
  const targets = names
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .filter((n) => {
      const key = normalizeText(n);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (targets.length === 0) return result;

  const normalized = targets.map((n) => normalizeText(n));
  // クリアランスで参照できない聖地エンティティは解決対象にしない
  // (見えないはずの聖地を entityNames から紐づけられてしまう)
  const candidates = await withClearance(clearance, (tx) =>
    tx.entity.findMany({
      where: {
        AND: [entityClearanceWhere(clearance), { normalizedName: { in: normalized } }],
      },
      select: { id: true, type: true, canonicalName: true, normalizedName: true },
    })
  );

  for (const inputName of targets) {
    const key = normalizeText(inputName);
    const matches = candidates.filter((c) => c.normalizedName === key);

    if (matches.length === 1) {
      result.resolved.push({
        id: matches[0].id,
        type: matches[0].type,
        name: matches[0].canonicalName,
        inputName,
      });
      continue;
    }

    if (matches.length > 1) {
      result.ambiguous.push({
        inputName,
        candidates: matches.map((m) => ({ id: m.id, type: m.type, name: m.canonicalName })),
      });
      continue;
    }

    if (options.createMissing) {
      const created = await prisma.entity.upsert({
        where: { type_canonicalName: { type: "tag", canonicalName: inputName } },
        update: {},
        create: { type: "tag", canonicalName: inputName, normalizedName: key },
      });
      result.resolved.push({
        id: created.id,
        type: created.type,
        name: created.canonicalName,
        inputName,
      });
      result.created.push(inputName);
      continue;
    }

    result.unresolved.push(inputName);
  }

  // 新規タグを作ったらエンティティ一覧のキャッシュを飛ばす。
  // getCachedEntityList は revalidate 300 秒なので、飛ばさないと最大 5 分
  // 検索フィルタに出てこない (createPlace 経由は invalidatePlaces が
  // entities タグも飛ばしていて、ここだけ抜けていた)
  if (result.created.length > 0) {
    invalidateEntities();
  }

  return result;
}

/** 未解決 / 曖昧な名前があるとき、AI への次の一手を文章で返す。無ければ undefined。 */
export function entityResolutionHint(resolution: EntityResolution): string | undefined {
  const parts: string[] = [];

  if (resolution.unresolved.length > 0) {
    parts.push(
      `一致するエンティティが無い名前があります: ${resolution.unresolved.join(", ")}。` +
        `akashic_list_entities で類似名を探して正式名称で指定し直すか、` +
        `本当に新規のタグでよければ createMissingEntities: true を付けて再実行してください。`
    );
  }

  if (resolution.ambiguous.length > 0) {
    const detail = resolution.ambiguous
      .map((a) => `${a.inputName} → ${a.candidates.map((c) => `${c.name}(${c.type})`).join(" / ")}`)
      .join("、 ");
    parts.push(
      `同名のエンティティが複数の種別で見つかりました: ${detail}。` +
        `どれを指すか確定できないので紐づけていません。`
    );
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}
