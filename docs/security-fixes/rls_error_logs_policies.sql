-- RLS Policies for error_logs table
-- This file sets up Row Level Security policies to allow the application
-- to use the anon/publishable key instead of the dangerous service role key
-- for error logging and error retrieval.

-- Step 1: Enable Row Level Security on the error_logs table
ALTER TABLE "error_logs" ENABLE ROW LEVEL SECURITY;

-- Step 2: Create policy allowing INSERT operations (for error logging)
-- This allows the anon role to insert error logs (used by logError function)
CREATE POLICY "error_logs_insert_anon"
ON "error_logs"
FOR INSERT
TO anon
USING (true)
WITH CHECK (true);

-- Step 3: Create policy allowing SELECT operations (for error retrieval)
-- This allows the anon role to select error logs (used by /api/pm/errors endpoint)
-- Note: The /api/pm/errors endpoint is still protected by PM_API_KEY authentication
CREATE POLICY "error_logs_select_anon"
ON "error_logs"
FOR SELECT
TO anon
USING (true);

-- Verification:
-- After running this SQL, you can verify the policies were created by:
-- 1. Going to Supabase Dashboard → Table Editor → error_logs
-- 2. Checking the "Row level security" section in the sidebar
-- 3. Confirming you see both policies listed:
--    - error_logs_insert_anon (under INSERT policies)
--    - error_logs_select_anon (under SELECT policies)