
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get("authorization");

    if (authHeader !== `Bearer ${process.env.PM_API_KEY}`) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
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

