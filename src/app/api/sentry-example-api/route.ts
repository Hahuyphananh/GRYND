import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

class SentryExampleAPIError extends Error {
  constructor(message: string | undefined) {
    super(message);
    this.name = "SentryExampleAPIError";
  }
}

/**
 * Sentry wizard-generated verification endpoint.
 *
 * In production this was an UNAUTHENTICATED route whose entire job is to
 * throw: anyone could use it to flood the error stream and spend the Sentry
 * quota, and it is not a product surface. It answers 404 there, and
 * src/proxy.ts refuses the path before routing; this in-handler guard keeps
 * the route honest even if it is invoked directly.
 */
export function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { success: false, error: "Not found" },
      { status: 404 },
    );
  }

  Sentry.logger.info("Sentry example API called");
  throw new SentryExampleAPIError(
    "This error is raised on the backend called by the example page.",
  );
}
