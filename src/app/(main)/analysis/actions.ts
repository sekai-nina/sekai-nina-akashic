"use server";

import { auth } from "@/lib/auth";
import {
  getWordFrequencyOverTime,
  getWordAppearanceRate,
  getVolumeOverTime,
  type AnalysisFilters,
} from "@/lib/domain/text-analysis";

export async function analyzeWords(words: string[], filters: AnalysisFilters) {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");

  const uniqueWords = [...new Set(words)].slice(0, 8);

  const [frequency, rate] = await Promise.all([
    getWordFrequencyOverTime(uniqueWords, filters),
    getWordAppearanceRate(uniqueWords, filters),
  ]);

  return { frequency, rate };
}

export async function analyzeVolume(filters: AnalysisFilters) {
  const session = await auth();
  if (!session?.user) throw new Error("Unauthorized");

  return getVolumeOverTime(filters);
}
