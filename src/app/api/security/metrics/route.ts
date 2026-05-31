import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { listAbuseMetrics } from "../../../../lib/security/abuseMetrics";
import { isAdmin } from "../../../../lib/auth/isAdmin";

export async function GET() {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  if (!(await isAdmin(userId)))
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 },
    );

  const metrics = listAbuseMetrics();
  return NextResponse.json({ success: true, metrics }, { status: 200 });
}
