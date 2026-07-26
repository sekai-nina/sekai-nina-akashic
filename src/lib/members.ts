/**
 * 日向坂46メンバーの期別と読み仮名。
 *
 * Entity.generation / Entity.reading の投入元。DB を直接編集する UI はまだ
 * 無いので、メンバーの増減があればここを直して `pnpm cli:sync-members` を
 * 流し直す。
 *
 * 出典: 公式サイトのメンバー一覧 (現役) と Wikipedia (卒業生)。
 */
export interface MemberProfile {
  /** Entity.canonicalName と一致させる表記 */
  name: string;
  /** ひらがな。姓名の区切りにスペースを入れる (五十音順の比較に使う) */
  reading: string;
  /** 期別 */
  generation: 1 | 2 | 3 | 4 | 5;
  /** 卒業済みかどうか (並び順を変える用途ではなく、名簿の由来を残すため) */
  graduated?: true;
}

export const MEMBERS: MemberProfile[] = [
  // 一期生
  { name: "佐々木久美", reading: "ささき くみ", generation: 1, graduated: true },
  { name: "佐々木美玲", reading: "ささき みれい", generation: 1, graduated: true },

  // 二期生
  { name: "金村美玖", reading: "かねむら みく", generation: 2 },
  { name: "小坂菜緒", reading: "こさか なお", generation: 2 },
  { name: "河田陽菜", reading: "かわた ひな", generation: 2, graduated: true },
  { name: "富田鈴花", reading: "とみた すずか", generation: 2, graduated: true },
  { name: "松田好花", reading: "まつだ このか", generation: 2, graduated: true },

  // 三期生
  { name: "上村ひなの", reading: "かみむら ひなの", generation: 3 },
  { name: "髙橋未来虹", reading: "たかはし みくに", generation: 3 },
  { name: "森本茉莉", reading: "もりもと まりぃ", generation: 3 },
  { name: "山口陽世", reading: "やまぐち はるよ", generation: 3 },

  // 四期生
  { name: "石塚瑶季", reading: "いしづか たまき", generation: 4 },
  { name: "小西夏菜実", reading: "こにし ななみ", generation: 4 },
  { name: "清水理央", reading: "しみず りお", generation: 4 },
  { name: "正源司陽子", reading: "しょうげんじ ようこ", generation: 4 },
  { name: "竹内希来里", reading: "たけうち きらり", generation: 4 },
  { name: "平尾帆夏", reading: "ひらお ほのか", generation: 4 },
  { name: "平岡海月", reading: "ひらおか みつき", generation: 4 },
  { name: "藤嶌果歩", reading: "ふじしま かほ", generation: 4 },
  { name: "宮地すみれ", reading: "みやち すみれ", generation: 4 },
  { name: "山下葉留花", reading: "やました はるか", generation: 4 },
  { name: "渡辺莉奈", reading: "わたなべ りな", generation: 4 },

  // 五期生
  { name: "大田美月", reading: "おおた みづき", generation: 5 },
  { name: "大野愛実", reading: "おおの まなみ", generation: 5 },
  { name: "片山紗希", reading: "かたやま さき", generation: 5 },
  { name: "蔵盛妃那乃", reading: "くらもり ひなの", generation: 5 },
  { name: "坂井新奈", reading: "さかい にいな", generation: 5 },
  { name: "佐藤優羽", reading: "さとう ゆう", generation: 5 },
  { name: "下田衣珠季", reading: "しもだ いずき", generation: 5 },
  { name: "高井俐香", reading: "たかい りか", generation: 5 },
  { name: "鶴崎仁香", reading: "つるさき にこ", generation: 5 },
  { name: "松尾桜", reading: "まつお さくら", generation: 5 },
];

/** 表記ゆれの吸収用。空白の有無だけの違いは正規化して照合する。 */
export function normalizeMemberName(name: string): string {
  return name.replace(/[\s　]/g, "");
}

const BY_NORMALIZED_NAME = new Map(
  MEMBERS.map((m) => [normalizeMemberName(m.name), m])
);

export function findMember(name: string): MemberProfile | undefined {
  return BY_NORMALIZED_NAME.get(normalizeMemberName(name));
}

export const GENERATION_LABELS: Record<number, string> = {
  1: "一期生",
  2: "二期生",
  3: "三期生",
  4: "四期生",
  5: "五期生",
};
