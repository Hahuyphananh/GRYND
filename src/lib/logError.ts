import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazily-create the client so a missing env var never crashes module load
// (which would break the app build). Error logging is best-effort: without
// Supabase configured we silently skip rather than fail the request.
let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!_supabase) _supabase = createClient(url.trim().replace(/\/$/, ""), key);
  return _supabase;
}

type ErrorDetails = {
  errorType?: string;
  errorMessage: string;
  stackTrace?: string;
  endpoint?: string;
  game?: string;
  appVersion?: string;
  device?: string;
  metadata?: Record<string, unknown>;
};

export async function logError({
  errorType = "application_error",
  errorMessage,
  stackTrace,
  endpoint,
  game,
  appVersion,
  device,
  metadata,
}: ErrorDetails) {
  try {
    const supabase = getSupabase();
    if (!supabase) return;
    const { error } = await supabase.from("error_logs").insert({
      error_type: errorType,
      error_message: errorMessage,
      stack_trace: stackTrace,
      endpoint,
      game,
      app_version: appVersion,
      device,
      metadata,
    });

    if (error) {
      console.error("Failed to log application error:", error);
    }
  } catch (loggingError) {
    console.error("Failed to log application error:", loggingError);
  }
}
