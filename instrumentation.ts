/**
 * Runs once when the Next.js server boots — before the first user request.
 * - Eagerly opens the Prisma connection so the user's first request doesn't
 *   eat the ~800ms cold-connect to the Supabase pooler.
 * - In dev, pre-compiles the hot routes by self-fetching as soon as the
 *   server is listening, so Turbopack doesn't compile them on demand
 *   during the user's first click.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Warm Prisma in the background (don't block boot).
  import("./src/lib/db").then(async ({ prisma }) => {
    try {
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      // First real query will retry.
    }
  });

  if (process.env.NODE_ENV !== "development") return;

  // Self-fetch the hot routes once the server is accepting connections.
  // Polls quickly so warmup starts as soon as possible after listen.
  const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
  const hotRoutes = ["/login", "/search", "/dashboard", "/assets", "/inbox", "/entities", "/gallery"];

  (async () => {
    // Wait for the server to start accepting connections.
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const r = await fetch(`${base}/login`, {
          signal: AbortSignal.timeout(2000),
          headers: { "x-prewarm": "1" },
        });
        if (r.status < 500) break;
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // Warm the rest sequentially so Turbopack doesn't thrash compiling
    // everything at once (parallel cold compiles contend for CPU and
    // make every route slower).
    for (const p of hotRoutes) {
      try {
        await fetch(`${base}${p}`, {
          signal: AbortSignal.timeout(15000),
          headers: { "x-prewarm": "1" },
        });
      } catch {
        // skip and continue
      }
    }
  })();
}
