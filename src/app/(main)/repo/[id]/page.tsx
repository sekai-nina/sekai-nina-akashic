import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { getCollection, listTweets } from "@/lib/domain/repo";
import { RepoCuration } from "./repo-curation";

export default async function RepoCollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) notFound();

  const { id } = await params;
  const collection = await getCollection(id, session.user.clearance);
  if (!collection) notFound();

  const tweets = await listTweets(id, { sort: "newest" }, session.user.clearance);

  const serialized = tweets.map((t) => ({
    id: t.id,
    tweetId: t.tweetId,
    authorUsername: t.authorUsername,
    authorName: t.authorName,
    text: t.text,
    tweetedAt: t.tweetedAt?.toISOString() ?? null,
    likeCount: t.likeCount,
    retweetCount: t.retweetCount,
    replyCount: t.replyCount,
    quoteCount: t.quoteCount,
    url: t.url,
    status: t.status,
    media: t.media.map((m) => ({
      id: m.id,
      type: m.type,
      imageUrl: m.imageUrl,
      altText: m.altText,
    })),
  }));

  return (
    <RepoCuration
      collection={{ id: collection.id, name: collection.name, query: collection.query }}
      tweets={serialized}
    />
  );
}
