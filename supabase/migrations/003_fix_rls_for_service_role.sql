-- Migration: Fix RLS policies to allow service role operations
-- The service role key needs to bypass RLS or have explicit permissions

-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Allow authenticated leads" ON leads;
DROP POLICY IF EXISTS "Allow authenticated drafts" ON drafts;
DROP POLICY IF EXISTS "Allow authenticated settings" ON settings;

-- Create new policies that allow both authenticated users AND service role
-- Service role should have full access for backend operations

-- Leads table policies
CREATE POLICY "Allow full access to leads" ON leads
  FOR ALL
  USING (
    auth.role() = 'authenticated' OR 
    auth.role() = 'service_role'
  )
  WITH CHECK (
    auth.role() = 'authenticated' OR 
    auth.role() = 'service_role'
  );

-- Drafts table policies
CREATE POLICY "Allow full access to drafts" ON drafts
  FOR ALL
  USING (
    auth.role() = 'authenticated' OR 
    auth.role() = 'service_role'
  )
  WITH CHECK (
    auth.role() = 'authenticated' OR 
    auth.role() = 'service_role'
  );

-- Settings table policies
CREATE POLICY "Allow full access to settings" ON settings
  FOR ALL
  USING (
    auth.role() = 'authenticated' OR 
    auth.role() = 'service_role'
  )
  WITH CHECK (
    auth.role() = 'authenticated' OR 
    auth.role() = 'service_role'
  );
