/**
 * クリップ (#41): 記事未定の抜粋を溜めるプール。
 *
 * 実体は **`kind = clips` の共有ドシエ 1 本** とその `DossierItem`。
 * 「これとこれで 1 記事」は、選んだクリップを新規 / 既存ドシエへ **移す** (`dossierId` の付け替え)
 * ことで表す。抜粋・メモ・ID がそのまま残るので、ドシエ → 記事の生成 (別 Issue) で出典に
 * 遡れる。
 *
 * 新テーブルにしなかったので RLS / GRANT / バックアップは Dossier 系のまま。DossierItem の
 * RLS は UPDATE の USING が移動元・WITH CHECK が移動先のドシエを見るので、移動もポリシー
 * 変更なしで通る。
 *
 * プールは view / edit とも `clearance` (internal) で、クリアランスが足りる全員に見える。
 * public クリアランスの人にはプール自体が RLS で見えない = `findClipPool` が null。
 */

import { ClearanceLevel, DossierKind, Prisma, type TextType } from "@prisma/client";
import { withSession } from "@/lib/db";
import { isAboveClearance } from "@/lib/classification";
import { canEditDossier } from "@/lib/auth/dossier-permissions";
import { locateExcerpt } from "@/lib/meetgreet/excerpt";
import { stripImagePlaceholders } from "@/lib/utils";
import { logAudit } from "./audit";
import { entityClearanceWhere } from "./entities";
import { nextSortOrder, requireEditAccess, updateDossierItem } from "./dossiers";

interface ActingUser {
  id: string;
  role: string;
  clearance: string;
}

const CLIP_POOL_TITLE = "クリップ";
/** プールの機密レベル。これより上のアセットはクリップできない (`createClip`) */
const CLIP_POOL_CLASSIFICATION = ClearanceLevel.internal;
/** 一度に移動・削除できる上限 (画面の全選択がこれを超えることはまず無い) */
const MAX_CLIPS_PER_BATCH = 200;
/** 一覧に載せる上限。プールはここまで溜まる前に振り分ける前提。超えたら `hasMore` で知らせる */
export const MAX_CLIPS_LISTED = 1000;

/** 入力起因の失敗。画面にそのまま出してよい文言 */
export class ClipInputError extends Error {}

const POOL_SELECT = {
  id: true,
  ownerId: true,
  classification: true,
  viewMode: true,
  editMode: true,
  kind: true,
} as const;

/** プールのドシエ。無い (まだ誰もクリップしていない) か、この人には見えないとき null */
export async function findClipPool(user: ActingUser) {
  return withSession(user, (tx) =>
    tx.dossier.findFirst({ where: { kind: DossierKind.clips }, select: POOL_SELECT })
  );
}

/**
 * プールが無ければ作る。
 *
 * 全体で 1 本なのは部分ユニーク索引 `Dossier_clips_singleton` が担保する。同時に 2 人が
 * 初回クリップすると片方が P2002 になるので、そのときは引き直す。
 *
 * プールは internal なので、それより下 (public) のクリアランスでは見えないし作れない
 * (作ろうとすると RLS の WITH CHECK で素の例外になる)。先に弾いて文言で返す。
 */
async function ensureClipPool(user: ActingUser) {
  if (isAboveClearance(CLIP_POOL_CLASSIFICATION, user.clearance)) {
    throw new ClipInputError("クリップのプールはあなたのクリアランスでは見えません");
  }
  const existing = await findClipPool(user);
  if (existing) return existing;
  try {
    return await withSession(user, (tx) =>
      tx.dossier.create({
        data: {
          ownerId: user.id,
          title: CLIP_POOL_TITLE,
          summary: "記事未定の抜粋を溜めておく場所。/clips から新規・既存のドシエへ振り分ける",
          classification: CLIP_POOL_CLASSIFICATION,
          viewMode: "clearance",
          editMode: "clearance",
          kind: DossierKind.clips,
        },
        select: POOL_SELECT,
      })
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const again = await findClipPool(user);
      if (again) return again;
    }
    throw e;
  }
}

// ============================================================
// 作成
// ============================================================

export interface CreateClipInput {
  assetId: string;
  note?: string;
  /** 引用。フローターの範囲選択か、スマホでの貼り付け */
  excerpt?: string;
  /** 範囲選択由来のときだけ付く。貼り付けなら本文から探す */
  excerptType?: TextType;
  excerptStart?: number;
  excerptEnd?: number;
}

/**
 * クリップを 1 件作る。メモか引用のどちらかは必須 (「何をクリップしたか」が無いと意味がない)。
 *
 * 引用の位置は必ず本文と突き合わせる:
 * - 範囲選択由来 (type + start/end あり) でも、本文のその範囲が引用と一致するときだけ採用する
 *   (本文が後から編集されていると位置がズレるので、ズレた範囲を保存しない)
 * - 貼り付け (位置なし) は `locateExcerpt` で本文から探す (空白・改行の違いは吸収する)
 * - どちらでも見つからなければ文字列だけ保持する (位置なし = ハイライトは出ない)
 *
 * classification がプール (internal) より上のアセットは入れない。DossierItem の抜粋文は
 * ドシエの classification で見えるので、confidential の本文が internal の人に漏れる。
 */
export async function createClip(user: ActingUser, input: CreateClipInput) {
  const note = (input.note ?? "").trim();
  const quote = (input.excerpt ?? "").trim();
  if (!note && !quote) throw new ClipInputError("メモか引用のどちらかを入れてください");

  const pool = await ensureClipPool(user);
  if (!canEditDossier(user, pool)) throw new ClipInputError("クリップを作る権限がありません");

  const item = await withSession(user, async (tx) => {
    // RLS 下で引くので、見えないアセットは null (= 存在確認を兼ねる)。
    // 本文は引用の位置を探すときだけ読む (メモだけのクリップで全文を引かない)
    const asset = await tx.asset.findUnique({
      where: { id: input.assetId },
      select: {
        title: true,
        classification: true,
        texts: quote
          ? { orderBy: { createdAt: "asc" }, select: { textType: true, content: true } }
          : false,
      },
    });
    if (!asset) throw new ClipInputError("アセットが見つかりません");
    if (isAboveClearance(asset.classification, pool.classification)) {
      throw new ClipInputError("このアセットの機密レベルはクリップのプールより上なので入れられません");
    }

    const located = quote && asset.texts ? locateQuote(asset.texts, quote, input) : null;
    const sortOrder = await nextSortOrder(tx, pool.id);
    return tx.dossierItem.create({
      data: {
        dossierId: pool.id,
        kind: "asset_ref",
        assetId: input.assetId,
        caption: asset.title || "",
        note,
        excerpt: located?.excerpt ?? quote,
        excerptType: located?.excerptType ?? null,
        excerptStart: located?.start ?? null,
        excerptEnd: located?.end ?? null,
        createdById: user.id,
        sortOrder,
      },
      select: { id: true, excerptStart: true, excerptEnd: true },
    });
  });

  await logAudit({
    actorId: user.id,
    action: "clip.create",
    targetType: "DossierItem",
    targetId: item.id,
    metadata: { assetId: input.assetId, located: item.excerptStart != null },
  });
  return item;
}

interface LocatedQuote {
  excerpt: string;
  excerptType: TextType;
  start: number;
  end: number;
}

/**
 * 引用を本文のどこかに確定する。詳細は `createClip` の JSDoc。
 *
 * 保存する `excerpt` は本文の範囲から画像プレースホルダ (`{{IMG:…}}`) を除いたもの。
 * 画像をまたいで選択するとプレースホルダが範囲に入るが、表示に出す文字列ではない。
 * 範囲 (start / end) はプレースホルダ込みの本文の添字のまま持つ (ハイライトはこちらを使う)。
 * 照合はどちらも `excerptOf(content, start, end)` で揃える (アセット詳細のハイライトも同じ)。
 */
function locateQuote(
  texts: { textType: TextType; content: string }[],
  quote: string,
  hint: Pick<CreateClipInput, "excerptType" | "excerptStart" | "excerptEnd">
): LocatedQuote | null {
  // 範囲選択由来: 同じ textType の本文でその範囲が引用と一致するものを探す
  // (同じ textType のテキストが複数あり得るので type だけでは決まらない)。
  // 範囲はクライアント入力なので、本文の中に収まる整数のときだけ信用する
  // (負数は slice が末尾から数えて「一致」してしまい、本文全体がハイライトされる)
  const { excerptType, excerptStart: start, excerptEnd: end } = hint;
  if (excerptType && start != null && end != null && Number.isInteger(start) && Number.isInteger(end)) {
    for (const t of texts) {
      if (t.textType !== excerptType) continue;
      if (start < 0 || end <= start || end > t.content.length) continue;
      const slice = t.content.slice(start, end);
      if (stripImagePlaceholders(slice).trim() === quote) {
        // 前後の空白を落とした分だけ範囲も詰める (ハイライトが空白から始まらないように)
        const lead = slice.length - slice.trimStart().length;
        const trail = slice.length - slice.trimEnd().length;
        return {
          excerpt: excerptOf(t.content, start + lead, end - trail),
          excerptType: t.textType,
          start: start + lead,
          end: end - trail,
        };
      }
    }
  }
  for (const t of texts) {
    const pos = locateExcerpt(t.content, quote);
    if (pos) {
      return {
        excerpt: excerptOf(t.content, pos.start, pos.end),
        excerptType: t.textType,
        start: pos.start,
        end: pos.end,
      };
    }
  }
  return null;
}

/**
 * 本文の範囲 → 保存・表示する抜粋文字列。画像プレースホルダを除く。
 * クリップの位置が本文と今も一致するかの照合 (アセット詳細) もこれで行う
 */
export function excerptOf(content: string, start: number, end: number): string {
  return stripImagePlaceholders(content.slice(start, end));
}

// ============================================================
// 一覧
// ============================================================

const CLIP_SELECT = (clearance: string) =>
  ({
    id: true,
    note: true,
    excerpt: true,
    excerptType: true,
    excerptStart: true,
    excerptEnd: true,
    caption: true,
    createdAt: true,
    createdById: true,
    createdBy: { select: { id: true, name: true } },
    asset: {
      select: {
        id: true,
        kind: true,
        title: true,
        canonicalDate: true,
        thumbnailUrl: true,
        entities: {
          // 上位機密の聖地の名前を漏らさない (entityClearanceWhere の JSDoc)
          where: { entity: entityClearanceWhere(clearance) },
          select: { entity: { select: { id: true, type: true, canonicalName: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    },
  }) satisfies Prisma.DossierItemSelect;

export type ClipListRow = Prisma.DossierItemGetPayload<{ select: ReturnType<typeof CLIP_SELECT> }>;

/** プールの item を指す where。プールが見えないクリアランスでは RLS で自然に 0 件になる */
const IN_CLIP_POOL = { dossier: { kind: DossierKind.clips } } as const;

/**
 * プールの中身を新しい順に返す。絞り込み・並び替えは画面側で行う
 * (件数が小さく、エンティティチップの集計も画面で済むため)。
 * `hasMore` は上限で切れたことを示す (画面で「古いものは表示していない」と出す)。
 */
export async function listClips(user: ActingUser): Promise<{ clips: ClipListRow[]; hasMore: boolean }> {
  const rows = await withSession(user, (tx) =>
    tx.dossierItem.findMany({
      where: IN_CLIP_POOL,
      orderBy: { createdAt: "desc" },
      take: MAX_CLIPS_LISTED + 1,
      select: CLIP_SELECT(user.clearance),
    })
  );
  return { clips: rows.slice(0, MAX_CLIPS_LISTED), hasMore: rows.length > MAX_CLIPS_LISTED };
}

/** あるアセットのクリップ (アセット詳細の「クリップ」セクションと本文のハイライト用) */
export async function listClipsForAsset(user: ActingUser, assetId: string) {
  return withSession(user, (tx) =>
    tx.dossierItem.findMany({
      where: { ...IN_CLIP_POOL, assetId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        note: true,
        excerpt: true,
        excerptType: true,
        excerptStart: true,
        excerptEnd: true,
        createdAt: true,
        createdBy: { select: { id: true, name: true } },
      },
    })
  );
}

// ============================================================
// 振り分け・削除
// ============================================================

export type MoveClipsTarget =
  | { kind: "dossier"; dossierId: string }
  | { kind: "new"; title: string };

interface MoveClipsResult {
  dossierId: string;
  moved: number;
}

/**
 * 選んだクリップを別のドシエへ移す。
 *
 * 移動先は既存のドシエ (編集権限が要る) か、新規ドシエ (タイトルだけ指定。共有設定は
 * `createDossier` の既定 = private、internal)。プール自身や別のプールへは移せない。
 *
 * 検証 → (新規なら) ドシエ作成 → 移動 を 1 トランザクションで行う。検証で失敗したのに
 * 空のドシエだけ残る、を避けるため。
 * - プールに無い id は黙って無視せず、件数の不一致として弾く (画面が古いときに
 *   「移したつもり」にならないように)
 * - 移動先の classification がアセットより下なら弾く (RLS の WITH CHECK はドシエしか見ない
 *   ので、internal の抜粋が public のドシエに移って下位に見える)。見えないアセットの
 *   クリップも弾く (機密が後から上がったもの)
 * - 移動は `updateMany` 1 文。sortOrder は移動先の末尾に揃え、同順位は createdAt で並ぶ
 *   (`getDossier` の orderBy)
 */
export async function moveClips(
  user: ActingUser,
  itemIds: string[],
  target: MoveClipsTarget
): Promise<MoveClipsResult> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) throw new ClipInputError("クリップが選ばれていません");
  if (ids.length > MAX_CLIPS_PER_BATCH) {
    throw new ClipInputError(`一度に移せるのは ${MAX_CLIPS_PER_BATCH} 件までです`);
  }
  const pool = await findClipPool(user);
  if (!pool) throw new ClipInputError("クリップのプールが見つかりません");

  let targetClassification: ClearanceLevel = ClearanceLevel.internal;
  let newTitle: string | null = null;
  if (target.kind === "new") {
    newTitle = target.title.trim();
    if (!newTitle) throw new ClipInputError("ドシエのタイトルを入れてください");
  } else {
    if (target.dossierId === pool.id) throw new ClipInputError("移動先がプール自身です");
    const access = await requireEditAccess(user, target.dossierId);
    if (access.kind === DossierKind.clips) throw new ClipInputError("プールへは移せません");
    targetClassification = access.classification;
  }

  const result = await withSession(user, async (tx) => {
    const found = await tx.dossierItem.findMany({
      where: { id: { in: ids }, dossierId: pool.id },
      select: { id: true, asset: { select: { classification: true } } },
    });
    if (found.length !== ids.length) {
      throw new ClipInputError("選んだクリップの一部が既に無くなっています。再読み込みしてください");
    }
    const tooHigh = found.filter(
      (f) => !f.asset || isAboveClearance(f.asset.classification, targetClassification)
    ).length;
    if (tooHigh > 0) {
      throw new ClipInputError(
        `${tooHigh} 件のアセットの機密レベルが移動先のドシエより上なので移せません`
      );
    }

    const dossierId =
      newTitle !== null
        ? (
            await tx.dossier.create({
              data: { ownerId: user.id, title: newTitle, classification: targetClassification },
              select: { id: true },
            })
          ).id
        : target.kind === "dossier"
          ? target.dossierId
          : "";

    const sortOrder = await nextSortOrder(tx, dossierId);
    const { count } = await tx.dossierItem.updateMany({
      where: { id: { in: ids }, dossierId: pool.id },
      data: { dossierId, sortOrder },
    });
    // RLS の USING / WITH CHECK で落ちた行があれば件数が減る。黙って一部だけ移さない
    if (count !== ids.length) {
      throw new ClipInputError("一部のクリップを移せませんでした (権限が変わった可能性があります)");
    }
    return { dossierId, moved: count };
  });

  if (newTitle !== null) {
    await logAudit({
      actorId: user.id,
      action: "dossier.create",
      targetType: "Dossier",
      targetId: result.dossierId,
      metadata: { title: newTitle, fromClips: true },
    });
  }
  await logAudit({
    actorId: user.id,
    action: "clip.move",
    targetType: "Dossier",
    targetId: result.dossierId,
    metadata: { itemIds: ids, created: newTitle !== null },
  });
  return result;
}

/** 選んだクリップを消す。プールに無い id は数に入らない (= 消えていた分は無視) */
export async function deleteClips(user: ActingUser, itemIds: string[]): Promise<number> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return 0;
  if (ids.length > MAX_CLIPS_PER_BATCH) {
    throw new ClipInputError(`一度に消せるのは ${MAX_CLIPS_PER_BATCH} 件までです`);
  }
  const pool = await findClipPool(user);
  if (!pool) return 0;
  if (!canEditDossier(user, pool)) throw new ClipInputError("クリップを消す権限がありません");

  const { count } = await withSession(user, (tx) =>
    tx.dossierItem.deleteMany({ where: { id: { in: ids }, dossierId: pool.id } })
  );
  if (count > 0) {
    await logAudit({
      actorId: user.id,
      action: "clip.delete",
      targetType: "Dossier",
      targetId: pool.id,
      metadata: { itemIds: ids, count },
    });
  }
  return count;
}

/** クリップのメモを書き換える。プールの外のアイテムは対象にしない (汎用の編集はドシエ側の action) */
export async function updateClipNote(user: ActingUser, itemId: string, note: string) {
  const item = await withSession(user, (tx) =>
    tx.dossierItem.findFirst({ where: { id: itemId, ...IN_CLIP_POOL }, select: { id: true } })
  );
  if (!item) throw new ClipInputError("クリップが見つかりません (消されたか、移動済みです)");
  await updateDossierItem(user, itemId, { note: note.trim() });
}
