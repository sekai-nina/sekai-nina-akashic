"use server";

import { auth } from "@/lib/auth";
import {
  getWordFrequencyOverTime,
  getWordAppearanceRate,
  getVolumeOverTime,
  type AnalysisFilters,
  type WordGroup,
} from "@/lib/domain/text-analysis";

export async function analyzeWords(
  groups: WordGroup[],
  filters: AnalysisFilters
) {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");

  const limited = groups.slice(0, 8);

  const [frequency, rate] = await Promise.all([
    getWordFrequencyOverTime(limited, filters),
    getWordAppearanceRate(limited, filters),
  ]);

  return { frequency, rate };
}

export async function analyzeVolume(filters: AnalysisFilters) {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");

  return getVolumeOverTime(filters);
}
