-- 0094: RLS policies for error_logs table to eliminate service role key usage
--
-- This migration sets up Row Level Security policies on the error_logs table
-- to allow the application to use the anon/publishable key instead of the
-- dangerous service role key for error logging and error retrieval.
--
-- The service role key bypasses ALL Row Level Security and poses a critical
-- security risk if exposed. By using properly configured RLS policies with
-- the anon key, we maintain the same functionality with least privilege.

-- Enable Row Level Security on the error_logs table
ALTER TABLE "error_logs" ENABLE ROW LEVEL SECURITY;

-- Create policy allowing INSERT operations (for error logging)
-- This allows the anon role to insert error logs (used by logError function)
CREATE POLICY "error_logs_insert_anon"
ON "error_logs"
FOR INSERT
TO anon
USING (true)
WITH CHECK (true);

-- Create policy allowing SELECT operations (for error retrieval via /api/pm/errors)
-- Note: The /api/pm/errors endpoint is still protected by PM_API_KEY authentication
CREATE POLICY "error_logs_select_anon"
ON "error_logs"
FOR SELECT
TO anon
USING (true);