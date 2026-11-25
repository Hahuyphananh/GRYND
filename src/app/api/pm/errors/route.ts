import { NextResponse } from "next/server";
import { verifyPmRequest } from "../../../../lib/security/pmAuth";
import { createClient } from "@supabase/supabase-js";

type DbClient = ReturnType<typeof createClient>;

// Lazily-create the client so a missing env var cannot crash the build or the
// route. Without Supabase configured this internal endpoint just reports it.
let _supabase: DbClient | null = null;
function getSupabase(): DbClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!_supabase) _supabase = createClient(url.trim().replace(/\/$/, ""), key);
  return _supabase;
}

export async function GET(request: Request) {
  try {
    const authError = verifyPmRequest(request);
    if (authError) return authError;

    const supabase = getSupabase();
    if (!supabase) {
      return NextResponse.json(
        { error: "Supabase is not configured" },
        { status: 500 }
      );
    }

    const { data, error } = await supabase
      .from("error_logs")
      .select("*")
      .gte(
        "created_at",
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      )
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      // The driver's message/details/hint expose table and policy internals.
      // They go to the server log; the key holder gets a stable message.
      console.error("Failed to fetch error logs:", error);

      return NextResponse.json(
        { error: "Failed to fetch error logs" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      period: "previous_24_hours",
      count: data?.length ?? 0,
      errors: data ?? [],
    });
  } catch (error) {
    console.error("PM errors endpoint error:", error);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

