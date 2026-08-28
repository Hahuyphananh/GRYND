import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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
    await supabase.from("error_logs").insert({
      error_type: errorType,
      error_message: errorMessage,
      stack_trace: stackTrace,
      endpoint,
      game,
      app_version: appVersion,
      device,
      metadata,
    });
  } catch (loggingError) {
  console.error("Failed to log application error:", loggingError);

  throw loggingError;
}
}
