-- ============================================================================
-- Kontur Härtung NACH 012_v12_1.sql: Ausführungsrechte für save_v12_binding.
-- 012_v12_1.sql legt public.save_v12_binding als SECURITY DEFINER an, setzt aber
-- keine Rechte — damit erbt die Funktion das Standard-EXECUTE für PUBLIC
-- (Supabase-Linter: anon_security_definer_function_executable /
--  authenticated_security_definer_function_executable).
-- Aufrufe erfolgen ausschließlich serverseitig mit Service-Schlüssel
-- (kontur-services.ts: db('rpc/save_v12_binding','POST',{...}) über createDB).
-- Diese Migration ändert 012 nicht, sondern zieht nur die Rechte nach.
-- ============================================================================

revoke all on function public.save_v12_binding(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_v12_binding(uuid, jsonb) to service_role;

-- Hinweis: public.save_finance_plan bleibt bewusst für `authenticated` ausführbar —
-- das Frontend ruft sie mit User-JWT (cloud.js save()); die Funktion ermittelt das
-- Konto ausschließlich über auth.uid() und prüft die Revision (SYNC_CONFLICT).
