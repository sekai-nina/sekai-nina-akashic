import { withClearance } from "@/lib/db";
import { normalizeText } from "@/lib/utils";
import { Prisma, AssetKind, AssetStatus, TrustLevel, SourceType } from "@prisma/client";

export interface SearchQuery {
  q: string;
  target?: "all" | "assets" | "texts";
  kind?: AssetKind;
  /** Match assets of any of these kinds (OR semantics). Merged with `kind`. */
  kinds?: AssetKind[];
  status?: AssetStatus;
  trustLevel?: TrustLevel;
  sourceType?: SourceType;
  entityId?: string;
  entityIds?: string[];
  /**
   * entityIds の結合方法。
   * "any" (既定) = いずれかを含む (OR) / "all" = すべてを含む (AND)
   */
  entityMatch?: "any" | "all";
  /** Match assets where any of these entities is linked with roleLabel='author' (OR semantics). */
  authorIds?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  perPage?: number;
}

export interface SearchResultItem {
  type: "asset" | "text";
  assetId: string;
  assetTitle: string;
  assetKind: AssetKind;
  assetStatus: AssetStatus;
  thumbnailUrl: string | null;
  storageUrl: string | null;
  snippets: string[];
  matchCount: number;
  matchField: string;
  /** Short preview of the asset body (e.g. トーク message), shown when the
   *  match itself isn't inside the body. Null when redundant. */
  bodyPreview: string | null;
  score: number;
  createdAt: Date;
  canonicalDate: Date | null;
  personNames: string[];
  tagNames: string[];
}

/** R2サムネイルがあればそれを使い、なければDriveプロキシにフォールバック */
function resolveImageUrl(
  thumbnailUrl: string | null,
  storageProvider: string | null,
  storageKey: string | null,
  kind: string
): string | null {
  // R2 サムネイルがあればそれを優先
  if (thumbnailUrl?.includes("/thumbnails/")) return thumbnailUrl;
  // Drive 画像はプロキシ経由
  if ((kind === "image" || kind === "video") && storageProvider === "gdrive" && storageKey) {
    return `/api/drive-image/${storageKey}`;
  }
  return thumbnailUrl;
}

export interface SearchResult {
  items: SearchResultItem[];
  total: number;
  page: number;
  perPage: number;
}

/**
 * Find all occurrences of query terms in text and return snippets.
 * Nearby occurrences are merged into a single snippet.
 */
function buildSnippets(text: string, query: string, contextLen = 80): { snippets: string[]; matchCount: number } {
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return { snippets: [text.slice(0, contextLen * 2) + (text.length > contextLen * 2 ? "…" : "")], matchCount: 0 };

  const lower = text.toLowerCase();

  // Find all match positions
  const positions: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    const termLower = term.toLowerCase();
    let cursor = 0;
    while (cursor < lower.length) {
      const idx = lower.indexOf(termLower, cursor);
      if (idx === -1) break;
      positions.push({ start: idx, end: idx + term.length });
      cursor = idx + term.length;
    }
  }

  if (positions.length === 0) {
    return { snippets: [text.slice(0, contextLen * 2) + (text.length > contextLen * 2 ? "…" : "")], matchCount: 0 };
  }

  // Sort by position
  positions.sort((a, b) => a.start - b.start);

  // Merge nearby positions into context ranges
  const ranges: Array<{ start: number; end: number }> = [];
  for (const pos of positions) {
    const ctxStart = Math.max(0, pos.start - contextLen);
    const ctxEnd = Math.min(text.length, pos.end + contextLen);
    if (ranges.length > 0 && ctxStart <= ranges[ranges.length - 1].end) {
      ranges[ranges.length - 1].end = Math.max(
        ranges[ranges.length - 1].end,
        ctxEnd
      );
    } else {
      ranges.push({ start: ctxStart, end: ctxEnd });
    }
  }

  const snippets = ranges.map((range) => {
    let snippet = "";
    if (range.start > 0) snippet += "…";
    snippet += text.slice(range.start, range.end);
    if (range.end < text.length) snippet += "…";
    return snippet;
  });

  return { snippets, matchCount: positions.length };
}

/** Fetch person and tag entity names for a list of asset IDs */
async function getEntityNames(
  assetIds: string[],
  tx: Parameters<Parameters<typeof withClearance>[1]>[0]
): Promise<{ persons: Map<string, string[]>; tags: Map<string, string[]> }> {
  if (assetIds.length === 0)
    return { persons: new Map(), tags: new Map() };
  const rows = await tx.$queryRaw<
    Array<{ assetId: string; name: string; type: string }>
  >`
    SELECT ae."assetId", e."canonicalName" as name, e.type
    FROM "AssetEntity" ae
    JOIN "Entity" e ON e.id = ae."entityId"
    WHERE ae."assetId"::text = ANY(${assetIds})
      AND e.type IN ('person', 'tag')
  `;
  const persons = new Map<string, string[]>();
  const tags = new Map<string, string[]>();
  for (const row of rows) {
    const map = row.type === "person" ? persons : tags;
    const names = map.get(row.assetId) ?? [];
    names.push(row.name);
    map.set(row.assetId, names);
  }
  return { persons, tags };
}

/**
 * Fetch a short body preview (message_body / body text) for a list of assets.
 * Used to surface トーク本文 etc. in results that matched by title/entity/date
 * rather than inside the body itself. Prefers message_body over body.
 */
async function getBodyPreviews(
  assetIds: string[],
  tx: Parameters<Parameters<typeof withClearance>[1]>[0],
  maxLen = 240
): Promise<Map<string, string>> {
  if (assetIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{ assetId: string; content: string }>>`
    SELECT DISTINCT ON (t."assetId") t."assetId", t."content"
    FROM "AssetText" t
    WHERE t."assetId"::text = ANY(${assetIds})
      AND t."textType" IN ('message_body', 'body')
    ORDER BY t."assetId",
      CASE t."textType" WHEN 'message_body' THEN 0 WHEN 'body' THEN 1 ELSE 2 END
  `;
  const map = new Map<string, string>();
  for (const row of rows) {
    const cleaned = row.content.replace(/\{\{IMG:[a-zA-Z0-9_-]+\}\}/g, "").trim();
    if (!cleaned) continue;
    map.set(row.assetId, cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "…" : cleaned);
  }
  return map;
}
/**
 * キーワード一致した AssetText から、一致箇所の周辺だけを1アセット1行で取り出す。
 * 全文を転送すると1行あたり数KBになるため、位置を求めて窓を切る。
 */
async function getTextMatches(
  assetIds: string[],
  tx: Parameters<Parameters<typeof withClearance>[1]>[0],
  terms: string[],
  likePatterns: string[],
  normalizedLikePatterns: string[]
): Promise<Map<string, { textType: string; content: string }>> {
  if (assetIds.length === 0 || terms.length === 0) return new Map();

  const positionExpression = Prisma.sql`LEAST(${Prisma.join(
    terms.map(
      (t) => Prisma.sql`COALESCE(NULLIF(position(lower(${t}) in lower(t."content")), 0), 999999)`
    ),
    ", "
  )})`;

  const rows = await tx.$queryRaw<Array<{ assetId: string; textType: string; content: string }>>`
    SELECT DISTINCT ON (t."assetId")
      t."assetId", t."textType",
      substring(t."content" FROM GREATEST(1, ${positionExpression} - 150) FOR 800) as content
    FROM "AssetText" t
    WHERE t."assetId"::text = ANY(${assetIds})
      AND (${Prisma.join(
        likePatterns.flatMap((pat, i) => [
          Prisma.sql`t."content" ILIKE ${pat}`,
          Prisma.sql`t."normalizedContent" ILIKE ${normalizedLikePatterns[i]}`,
        ]),
        " OR "
      )})
    ORDER BY t."assetId", ${positionExpression}
  `;

  const map = new Map<string, { textType: string; content: string }>();
  for (const row of rows) {
    map.set(row.assetId, { textType: row.textType, content: row.content });
  }
  return map;
}

/** キーワードに一致したタグ/人物名を、1アセット1件だけ取り出す */
async function getMatchingEntityNames(
  assetIds: string[],
  tx: Parameters<Parameters<typeof withClearance>[1]>[0],
  likePatterns: string[],
  normalizedLikePatterns: string[]
): Promise<Map<string, string>> {
  if (assetIds.length === 0 || likePatterns.length === 0) return new Map();

  const rows = await tx.$queryRaw<Array<{ assetId: string; name: string }>>`
    SELECT DISTINCT ON (ae."assetId") ae."assetId", e."canonicalName" as name
    FROM "AssetEntity" ae
    JOIN "Entity" e ON e."id" = ae."entityId"
    WHERE ae."assetId"::text = ANY(${assetIds})
      AND (${Prisma.join(
        likePatterns.flatMap((pat, i) => [
          Prisma.sql`e."canonicalName" ILIKE ${pat}`,
          Prisma.sql`e."normalizedName" ILIKE ${normalizedLikePatterns[i]}`,
        ]),
        " OR "
      )})
    ORDER BY ae."assetId", length(e."canonicalName")
  `;

  const map = new Map<string, string>();
  for (const row of rows) map.set(row.assetId, row.name);
  return map;
}

/**
 * URL がそのまま貼られたときの照合候補。URL でなければ空配列。
 *
 * 共有 URL には ?ima=0000 のような追跡パラメータが付くので、クエリと
 * フラグメントを落として比較する。ILIKE ではなく完全一致で引くのは、
 * RLS 下でも leakproof な `=` なら遅くならないため (ILIKE 606ms → = 121ms)。
 */
export function urlMatchCandidates(q: string): string[] {
  const trimmed = q.trim();
  if (!/^https?:\/\//i.test(trimmed)) return [];

  let normalized = trimmed;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.search = "";
    normalized = parsed.toString();
  } catch {
    // パースできなければ入力のまま使う
  }
  const withoutTrailingSlash = normalized.replace(/\/+$/, "");
  return [...new Set([trimmed, normalized, withoutTrailingSlash, `${withoutTrailingSlash}/`])];
}

/**
 * 検索語の分割。"/" 区切りで OR 検索するが、URL は "/" を含むので分割しない。
 * ハイライト表示と条件生成で同じ結果を使う必要がある。
 */
export function splitQueryTerms(q: string): string[] {
  const trimmed = q.trim();
  if (!trimmed) return [];
  if (urlMatchCandidates(trimmed).length > 0) return [trimmed];
  return trimmed.split("/").map((t) => t.trim()).filter(Boolean);
}

interface AssetRow {
  id: string;
  title: string;
  description: string;
  kind: AssetKind;
  status: AssetStatus;
  thumbnailUrl: string | null;
  storageUrl: string | null;
  storageProvider: string | null;
  storageKey: string | null;
  messageBodyPreview: string | null;
  createdAt: Date;
  canonicalDate: Date | null;
}

export async function search(query: SearchQuery, clearance: string): Promise<SearchResult> {
  const { q, target = "all", page = 1, perPage = 20 } = query;
  const offset = (page - 1) * perPage;
  const hasKeyword = q.trim().length > 0;

  // URL は "/" を含むので、OR 分割せず1語として扱う
  const urlCandidates = urlMatchCandidates(q);
  const isUrlQuery = urlCandidates.length > 0;

  // "/" 区切りで OR 検索
  const terms = hasKeyword ? splitQueryTerms(q) : [];
  const normalizedTerms = terms.map((t) => normalizeText(t));
  const likePatterns = terms.map((t) => `%${t}%`);
  const normalizedLikePatterns = normalizedTerms.map((t) => `%${t}%`);

  const assetWhereConditions: Prisma.Sql[] = [];

  // Base filters (no classificationFilterSql needed — RLS handles it)
  const kinds = [...new Set([...(query.kind ? [query.kind] : []), ...(query.kinds ?? [])])];
  if (kinds.length > 0) {
    assetWhereConditions.push(
      Prisma.sql`a."kind" IN (${Prisma.join(kinds.map((k) => Prisma.sql`${k}::"AssetKind"`))})`
    );
  }
  if (query.status) assetWhereConditions.push(Prisma.sql`a."status" = ${query.status}::"AssetStatus"`);
  if (query.trustLevel) assetWhereConditions.push(Prisma.sql`a."trustLevel" = ${query.trustLevel}::"TrustLevel"`);
  if (query.sourceType) assetWhereConditions.push(Prisma.sql`a."sourceType" = ${query.sourceType}::"SourceType"`);
  if (query.dateFrom) assetWhereConditions.push(Prisma.sql`COALESCE(a."canonicalDate", a."createdAt") >= ${query.dateFrom}`);
  if (query.dateTo) {
    // dateTo is a date without time — include the entire day
    const endOfDay = new Date(query.dateTo);
    endOfDay.setDate(endOfDay.getDate() + 1);
    assetWhereConditions.push(Prisma.sql`COALESCE(a."canonicalDate", a."createdAt") < ${endOfDay}`);
  }

  const baseFilter = assetWhereConditions.length > 0
    ? Prisma.sql`AND ${Prisma.join(assetWhereConditions, " AND ")}`
    : Prisma.empty;

  // Entity filter as subquery.
  // 既定は OR（いずれかのタグ/人物を含む）。entityMatch: "all" で AND になる。
  const allEntityIds = [
    ...(query.entityId ? [query.entityId] : []),
    ...(query.entityIds ?? []),
  ];
  const entityFilter = allEntityIds.length === 0
    ? Prisma.empty
    : query.entityMatch === "all"
      ? Prisma.sql`${Prisma.join(
          allEntityIds.map(
            (eid) =>
              Prisma.sql`AND EXISTS (SELECT 1 FROM "AssetEntity" ae WHERE ae."assetId" = a."id" AND ae."entityId" = ${eid})`
          ),
          " "
        )}`
      : Prisma.sql`AND EXISTS (
          SELECT 1 FROM "AssetEntity" ae
          WHERE ae."assetId" = a."id"
          AND ae."entityId" IN (${Prisma.join(allEntityIds)})
        )`;

  // Author filter: any of the given entities linked with roleLabel='author' (OR within group)
  const authorIds = query.authorIds ?? [];
  const authorFilter = authorIds.length > 0
    ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM "AssetEntity" ae
        WHERE ae."assetId" = a."id"
        AND ae."roleLabel" = 'author'
        AND ae."entityId" IN (${Prisma.join(authorIds)})
      )`
    : Prisma.empty;

  // キーワードなし＋フィルタもなし → 空結果
  const hasFilters = assetWhereConditions.length > 0 || allEntityIds.length > 0 || authorIds.length > 0;
  if (!hasKeyword && !hasFilters) {
    return { items: [], total: 0, page, perPage };
  }

  // 一致条件はソースごとに分けて UNION する。
  // OR でまとめてしまうと trigram インデックスが使えず Asset 全件走査になる
  // (計測: 84,966行の Seq Scan で 920ms → ソース別 UNION で 205ms)。
  const anyOf = (column: Prisma.Sql, patterns: string[]) =>
    Prisma.sql`(${Prisma.join(patterns.map((pat) => Prisma.sql`${column} ILIKE ${pat}`), " OR ")})`;

  /** 素の列と正規化列の両方に対する一致条件 */
  const plainOrNormalized = (plain: Prisma.Sql, normalized: Prisma.Sql) =>
    Prisma.sql`(${Prisma.join(
      likePatterns.flatMap((pat, i) => [
        Prisma.sql`${plain} ILIKE ${pat}`,
        Prisma.sql`${normalized} ILIKE ${normalizedLikePatterns[i]}`,
      ]),
      " OR "
    )})`;

  // target=texts は本文のみ、target=assets は本文を除く
  const searchAssetFields = target === "all" || target === "assets";
  const searchTextContent = target === "all" || target === "texts";

  const assetFilters = Prisma.sql`${baseFilter} ${entityFilter} ${authorFilter}`;
  // Asset 側の絞り込みが無いなら、AssetText / AssetEntity から引くブランチで
  // Asset を JOIN する必要がない (RLS は各テーブル側でも親の分類を見ている)。
  // 無駄な JOIN を外すと素のキーワード検索が 1810ms → 1354ms になる。
  const hasAssetFilters =
    assetWhereConditions.length > 0 || allEntityIds.length > 0 || authorIds.length > 0;
  const joinAssetForFilters = hasAssetFilters
    ? Prisma.sql`JOIN "Asset" a ON a."id" = ae."assetId"`
    : Prisma.empty;
  const joinAssetForTextFilters = hasAssetFilters
    ? Prisma.sql`JOIN "Asset" a ON a."id" = t."assetId"`
    : Prisma.empty;
  const filtersIfJoined = hasAssetFilters ? assetFilters : Prisma.empty;

  /** 一致元ごとの候補。rank は旧実装のスコアを踏襲 (タイトル3 / 説明・タグ2 / それ以外1)。 */
  const branches: Prisma.Sql[] = [];
  if (isUrlQuery) {
    // URL を貼った場合は「そのURLのアセットを引く」用途なので、本文などの
    // 部分一致は当てずに URL 列だけを見る。完全一致なので RLS 下でも速い。
    branches.push(Prisma.sql`
      SELECT s."assetId" AS id, 3 AS rank
      FROM "SourceRecord" s
      JOIN "Asset" a ON a."id" = s."assetId"
      WHERE s."url" = ANY(${urlCandidates}) ${assetFilters}`);
    branches.push(Prisma.sql`
      SELECT a."id", 3 AS rank FROM "Asset" a
      WHERE a."storageUrl" = ANY(${urlCandidates}) ${assetFilters}`);
    branches.push(Prisma.sql`
      SELECT a."id", 3 AS rank FROM "Asset" a
      WHERE a."discordMessageUrl" = ANY(${urlCandidates}) ${assetFilters}`);
  } else if (hasKeyword) {
    if (searchAssetFields) {
      branches.push(Prisma.sql`
        SELECT a."id", 3 AS rank FROM "Asset" a
        WHERE ${anyOf(Prisma.sql`a."title"`, likePatterns)} ${assetFilters}`);
      branches.push(Prisma.sql`
        SELECT a."id", 2 AS rank FROM "Asset" a
        WHERE ${anyOf(Prisma.sql`a."description"`, likePatterns)} ${assetFilters}`);
      // COALESCE で包むとインデックスが使えなくなるので、NULL はそのまま外れさせる
      branches.push(Prisma.sql`
        SELECT a."id", 1 AS rank FROM "Asset" a
        WHERE ${anyOf(Prisma.sql`a."messageBodyPreview"`, likePatterns)} ${assetFilters}`);
      branches.push(Prisma.sql`
        SELECT ae."assetId" AS id, 2 AS rank
        FROM "AssetEntity" ae
        JOIN "Entity" e ON e."id" = ae."entityId"
        ${joinAssetForFilters}
        WHERE ${plainOrNormalized(Prisma.sql`e."canonicalName"`, Prisma.sql`e."normalizedName"`)} ${filtersIfJoined}`);
    }
    if (searchTextContent) {
      branches.push(Prisma.sql`
        SELECT t."assetId" AS id, 1 AS rank
        FROM "AssetText" t
        ${joinAssetForTextFilters}
        WHERE ${plainOrNormalized(Prisma.sql`t."content"`, Prisma.sql`t."normalizedContent"`)} ${filtersIfJoined}`);
    }
  } else {
    // キーワード無しはフィルタだけで絞る
    branches.push(Prisma.sql`
      SELECT a."id", 1 AS rank FROM "Asset" a WHERE TRUE ${assetFilters}`);
  }

  // 以前は「タイトル等」「タグ名」「本文」を別々のクエリで LIMIT していたため、
  // マージ時に溢れた一致がどのページにも現れなかった。候補を1つに束ねて
  // count(*) OVER () で総数も同時に取る。
  const rows = await withClearance(clearance, (tx) =>
    tx.$queryRaw<Array<AssetRow & { rank: number; total_count: bigint }>>`
      WITH matched AS (
        ${Prisma.join(branches, " UNION ALL ")}
      ), ranked AS (
        SELECT id, max(rank) AS rank FROM matched GROUP BY id
      )
      SELECT
        a."id", a."title", a."description", a."kind", a."status",
        a."thumbnailUrl", a."storageUrl", a."storageProvider", a."storageKey",
        a."messageBodyPreview", a."createdAt", a."canonicalDate",
        r."rank", count(*) OVER () AS total_count
      FROM ranked r
      JOIN "Asset" a ON a."id" = r."id"
      ORDER BY r."rank" DESC,
        COALESCE(a."canonicalDate", a."createdAt") DESC,
        a."id" ASC
      LIMIT ${perPage} OFFSET ${offset}
    `
  );

  const total = rows.length > 0 ? Number(rows[0].total_count) : 0;

  if (rows.length === 0) {
    return { items: [], total, page, perPage };
  }

  const termsLower = terms.map((t) => t.toLowerCase());
  const matchesAny = (text: string | null) =>
    hasKeyword && !!text && termsLower.some((t) => text.toLowerCase().includes(t));

  // アセット行だけで一致箇所が分かるものと、本文/タグを引き当てる必要があるものを分ける
  const needsLookup = rows.filter(
    (row) =>
      hasKeyword &&
      !(searchAssetFields &&
        (matchesAny(row.title) || matchesAny(row.description) || matchesAny(row.messageBodyPreview)))
  );
  const lookupIds = needsLookup.map((row) => row.id);
  const assetIds = rows.map((row) => row.id);

  const { persons, tags, textMatches, entityNameHits, bodyPreviews } = await withClearance(
    clearance,
    async (tx) => {
      const [names, texts, entityHits] = await Promise.all([
        getEntityNames(assetIds, tx),
        searchTextContent
          ? getTextMatches(lookupIds, tx, terms, likePatterns, normalizedLikePatterns)
          : Promise.resolve(new Map<string, { textType: string; content: string }>()),
        searchAssetFields
          ? getMatchingEntityNames(lookupIds, tx, likePatterns, normalizedLikePatterns)
          : Promise.resolve(new Map<string, string>()),
      ]);
      // 本文が一致源でないものには、トーク本文などのプレビューを別途付ける
      const previewIds = rows
        .filter((row) => !texts.has(row.id))
        .map((row) => row.id);
      const previews = await getBodyPreviews(previewIds, tx);
      return {
        persons: names.persons,
        tags: names.tags,
        textMatches: texts,
        entityNameHits: entityHits,
        bodyPreviews: previews,
      };
    }
  );

  const items: SearchResultItem[] = rows.map((row) => {
    const titleHit = searchAssetFields && matchesAny(row.title);
    const descHit = searchAssetFields && matchesAny(row.description);
    const previewHit = searchAssetFields && matchesAny(row.messageBodyPreview);
    const textHit = textMatches.get(row.id);
    const entityHit = entityNameHits.get(row.id);

    let type: "asset" | "text" = "asset";
    let matchField = "title";
    let matchText = row.title;
    let score = 0;
    let snippets: string[];
    let matchCount = 0;

    if (!hasKeyword) {
      snippets = [row.title];
    } else if (isUrlQuery) {
      matchField = "sourceUrl";
      score = 3;
      snippets = [q.trim()];
      matchCount = 1;
    } else if (titleHit) {
      matchField = "title";
      score = 3;
      ({ snippets, matchCount } = buildSnippets(row.title, q));
    } else if (descHit) {
      matchField = "description";
      matchText = row.description;
      score = 2;
      ({ snippets, matchCount } = buildSnippets(row.description, q));
    } else if (previewHit) {
      matchField = "messageBodyPreview";
      matchText = row.messageBodyPreview ?? "";
      score = 1;
      ({ snippets, matchCount } = buildSnippets(matchText, q));
    } else if (textHit) {
      type = "text";
      matchField = textHit.textType;
      score = 1;
      ({ snippets, matchCount } = buildSnippets(textHit.content, q));
    } else if (entityHit) {
      matchField = "entity";
      score = 2;
      snippets = [`タグ/人物: ${entityHit}`];
      matchCount = 1;
    } else {
      snippets = [row.title];
    }

    return {
      type,
      assetId: row.id,
      assetTitle: row.title || "(無題)",
      assetKind: row.kind,
      assetStatus: row.status,
      thumbnailUrl: resolveImageUrl(row.thumbnailUrl, row.storageProvider, row.storageKey, row.kind),
      storageUrl: row.storageUrl,
      snippets,
      matchCount,
      matchField,
      bodyPreview: type === "text" ? null : bodyPreviews.get(row.id) ?? null,
      score,
      createdAt: row.createdAt,
      canonicalDate: row.canonicalDate,
      personNames: persons.get(row.id) ?? [],
      tagNames: tags.get(row.id) ?? [],
    };
  });

  return { items, total, page, perPage };
}
