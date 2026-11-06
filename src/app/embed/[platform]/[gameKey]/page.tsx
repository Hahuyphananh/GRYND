import type { Metadata } from "next";
import Link from "next/link";

import { getPlatformConfig, isPlatformGameKey } from "../../../../lib/platform/config";
import { validatePlatformToken } from "../../../../lib/platform/session";
import EmbedClient from "./EmbedClient";

// An embed is a private, authenticated surface: never indexed, never cached,
// and always validated per request against the platform_sessions row.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  title: "GRYND — practice",
  description: "GRYND practice game.",
};

function InvalidSession() {
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-[#000d1a] px-6 text-white"
      style={{ background: "linear-gradient(135deg, #001933 0%, #000d1a 100%)" }}
    >
      <div className="max-w-md rounded-xl border border-white/10 bg-white/5 p-6 text-center">
        <h1 className="text-lg font-bold text-white">This game session has ended</h1>
        <p className="mt-2 text-sm text-[#9dd8ff]/80">
          The link is invalid or expired. Return to the platform and start the game again.
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#00e5ff]"
        >
          Open GRYND
        </Link>
      </div>
    </main>
  );
}

export default async function EmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ platform: string; gameKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { platform, gameKey } = await params;
  const query = await searchParams;
  const rawSession = query.session;
  const token = typeof rawSession === "string" ? rawSession : "";

  const config = getPlatformConfig(platform);
  if (!config || !isPlatformGameKey(gameKey) || !token) return <InvalidSession />;

  // Server-side validation of signature-equivalent (hashed opaque) token,
  // expiry, revocation, platform, game and origin binding.
  const session = await validatePlatformToken(token, { platform, gameKey });
  if (!session || session.platformOrigin !== config.origin) return <InvalidSession />;

  return (
    <EmbedClient
      token={token}
      platform={session.platform}
      gameKey={session.gameKey}
      platformOrigin={session.platformOrigin}
      expiresAt={session.expiresAt.toISOString()}
    />
  );
}
