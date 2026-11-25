/**
 * Sentry tunnel endpoint.
 *
 * `withSentryConfig` is configured with `tunnelRoute: "/monitoring"`, so the
 * browser posts envelopes same-origin and ad-blockers cannot drop them. When
 * this file exists, @sentry/nextjs (`findTunnelRouteHandlerFile`) stops
 * generating its external `/monitoring -> o<org>.ingest.sentry.io` rewrite and
 * instead rewrites `/monitoring` to this handler. That external rewrite was the
 * request answering 500, so the relay lives in our own app now.
 *
 * The envelope's first line is a JSON header naming the DSN the client used.
 * Only its host and project id are needed to build the ingest URL, and both are
 * validated before the outbound request so this route cannot be pointed at an
 * arbitrary host (SSRF).
 */

const SENTRY_SAAS_HOST = /^o\d+\.ingest(\.[a-z]{2})?\.sentry\.io$/;

function ingestUrlFor(envelope: string): string | null {
  // Envelope format: a JSON header line, then one or more item headers/payloads.
  const headerLine = envelope.split("\n", 1)[0];

  let dsn: string | undefined;
  try {
    const header = JSON.parse(headerLine) as { dsn?: unknown };
    if (typeof header.dsn === "string") dsn = header.dsn;
  } catch {
    return null;
  }
  if (!dsn) return null;

  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    return null;
  }

  const projectId = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (!SENTRY_SAAS_HOST.test(parsed.hostname) || !/^\d+$/.test(projectId)) {
    return null;
  }

  return `https://${parsed.hostname}/api/${projectId}/envelope/`;
}

export async function POST(request: Request): Promise<Response> {
  const envelope = await request.text();
  const target = ingestUrlFor(envelope);
  if (!target) {
    return new Response(null, { status: 400 });
  }

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: envelope,
    });
    return new Response(null, { status: upstream.ok ? 200 : 502 });
  } catch {
    return new Response(null, { status: 502 });
  }
}
