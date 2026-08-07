// src/app/api/reports/submit/route.ts
// POST → submit a player report from a PVP game
//
// Thin wrapper around the framework-free core in src/lib/reports/submitReport
// (which is unit-tested with node --test in tests/report-submit.test.mjs).

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";
import {
  submitReport,
  ensurePlayerReportsTable,
  type SubmitReportPayload,
} from "../../../../lib/reports/submitReport";

// Self-healing: ensure the player_reports table exists on first request.
// The migration (0030_add_player_reports.sql) may not have run if an earlier
// migration stalled. This flag prevents re-running DDL on every request.
let tableEnsured = false;

export async function POST(req: NextRequest) {
  const { userId } = await auth();

  const body = (await req.json().catch(() => null)) as SubmitReportPayload | null;

  const result = await submitReport(userId, body, {
    sql: getNeonSql(),
    ensureTable: async () => {
      if (tableEnsured) return;
      await ensurePlayerReportsTable(getNeonSql());
      tableEnsured = true;
    },
  });

  return NextResponse.json(
    {
      success: result.success,
      ...(result.error ? { error: result.error } : {}),
      ...(result.message ? { message: result.message } : {}),
    },
    { status: result.status },
  );
}
