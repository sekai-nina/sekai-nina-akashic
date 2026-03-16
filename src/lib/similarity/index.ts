// Placeholder for future similarity search (e.g., perceptual hashing, vector embeddings)
// MVP only supports exact sha256 duplicate detection.

export interface SimilarityResult {
  assetId: string;
  score: number;
}

export async function findSimilar(_assetId: string): Promise<SimilarityResult[]> {
  // Future: implement perceptual hashing or vector similarity
  return [];
}
