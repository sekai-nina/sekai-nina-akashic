import { withClearance } from "@/lib/db";

/**
 * 案内AI「ふぃたん」の運転スイッチ。
 *
 * サイトの表示はビルド時に焼き込まれるため、止めたいときに作り直していては間に合わない。
 * Worker がここを見に来る形にして、Akashic から即座に止められるようにしている。
 *
 * 行が無いときは「有効」として扱う。入れ忘れで AI が止まるほうが事故だから。
 */
export const SINGLETON_ID = "singleton";

export interface AiSettingView {
  enabled: boolean;
  note: string;
  updatedAt: Date | null;
  updatedByName: string | null;
}

export async function getAiSetting(clearance: string): Promise<AiSettingView> {
  const row = await withClearance(clearance, (tx) =>
    tx.aiSetting.findUnique({
      where: { id: SINGLETON_ID },
      include: { updatedBy: { select: { name: true } } },
    })
  );
  if (!row) return { enabled: true, note: "", updatedAt: null, updatedByName: null };
  return {
    enabled: row.enabled,
    note: row.note,
    updatedAt: row.updatedAt,
    updatedByName: row.updatedBy?.name ?? null,
  };
}

export async function setAiEnabled(
  enabled: boolean,
  note: string,
  clearance: string,
  userId: string
): Promise<AiSettingView> {
  await withClearance(clearance, (tx) =>
    tx.aiSetting.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, enabled, note, updatedById: userId },
      update: { enabled, note, updatedById: userId },
    })
  );
  return getAiSetting(clearance);
}
