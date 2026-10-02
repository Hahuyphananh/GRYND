// ONE-CLICK UNSUBSCRIBE — the target of the link every marketing email carries.
//
//   GET  /api/emails/unsubscribe?token=…   → human click, renders a styled page
//   POST /api/emails/unsubscribe?token=…   → RFC 8058 one-click (mail clients)
//
// The token is HMAC-signed (see src/lib/emails/unsubscribe.ts), so the request
// is authorised without a session cookie — recipients are usually reading in a
// mail client. Unsubscribing is deliberately all-or-nothing: it flips every
// marketing preference off. Fine-grained control stays in /settings.
//
// Every successful unsubscribe is recorded in email_events (type
// "unsubscribe") so opt-outs can be audited alongside the sends they follow.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { t } from "../../../../lib/appTextTranslations";
import {
  ALL_MARKETING_OFF,
  getAppBaseUrl,
  recordUnsubscribeEvent,
  resolveUnsubscribeLanguage,
  verifyUnsubscribeToken,
  type UnsubscribeSource,
} from "../../../../lib/emails/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UnsubscribeResult = "ok" | "invalid" | "error";

async function unsubscribe(
  token: unknown,
  source: UnsubscribeSource,
): Promise<UnsubscribeResult> {
  const clerkId = verifyUnsubscribeToken(token);
  if (!clerkId) return "invalid";

  try {
    const [row] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    // A validly signed token for a deleted/unknown account has nothing to do.
    if (!row?.email) return "invalid";

    await db
      .update(users)
      .set({ notificationPrefs: ALL_MARKETING_OFF })
      .where(eq(users.clerkId, clerkId));

    await recordUnsubscribeEvent({ clerkId, email: row.email, source });
    return "ok";
  } catch (err) {
    console.error("[unsubscribe] update failed:", (err as Error)?.message);
    return "error";
  }
}

function renderPage({
  ok,
  title,
  body,
  lang = "en",
}: {
  ok: boolean;
  title: string;
  body: string;
  lang?: string;
}) {
  const accent = ok ? "#10b981" : "#f87171";
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · GRYND</title></head>
<body style="margin:0;background:#0f172a;color:#e2e8f0;font-family:Inter,Arial,sans-serif">
<div style="max-width:520px;margin:12vh auto;padding:32px;background:#111c33;border:1px solid ${accent}55;border-radius:14px;text-align:center">
<h1 style="color:#fbbf24;margin-top:0">GRYND</h1>
<h2 style="color:${accent};margin-bottom:8px">${title}</h2>
<p style="opacity:.85;line-height:1.5">${body}</p>
</div></body></html>`;
}

function htmlResponse(html: string, status = 200) {
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function settingsLink(label: string) {
  return `<a href="${getAppBaseUrl()}/settings" style="color:#7dd3fc">${label}</a>`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lang = resolveUnsubscribeLanguage(
    req.headers.get("accept-language"),
    url.searchParams.get("lang"),
  );

  const result = await unsubscribe(url.searchParams.get("token"), "email_link");

  if (result === "invalid") {
    return htmlResponse(
      renderPage({
        ok: false,
        lang,
        title: t(lang, "unsubscribe.invalidTitle"),
        body: `${t(
          lang,
          "unsubscribe.invalidBody",
        )} ${settingsLink(t(lang, "unsubscribe.settingsLink"))}.`,
      }),
      400,
    );
  }

  if (result === "error") {
    return htmlResponse(
      renderPage({
        ok: false,
        lang,
        title: t(lang, "unsubscribe.errorTitle"),
        body: `${t(
          lang,
          "unsubscribe.errorBody",
        )} ${settingsLink(t(lang, "unsubscribe.settingsLink"))}.`,
      }),
      500,
    );
  }

  return htmlResponse(
    renderPage({
      ok: true,
      lang,
      title: t(lang, "unsubscribe.unsubscribedTitle"),
      body: `${t(
        lang,
        "unsubscribe.unsubscribedBody",
      )} ${t(lang, "unsubscribe.managePrefix")} ${settingsLink(
        t(lang, "unsubscribe.settingsLink"),
      )}.`,
    }),
  );
}

// RFC 8058 one-click: mail clients POST here from the List-Unsubscribe header.
// Always answers 200 (even for a bad token) so the client marks the attempt as
// handled rather than surfacing an error banner to the recipient.
export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  await unsubscribe(token, "one_click");
  return NextResponse.json({ success: true });
}
