-- ============================================================================
-- 015_cron_jobs.sql — Versionierung der produktiven Cron-Jobs
--
-- Jobs (laufen bereits live auf dem Projekt, hier nur als Code festgehalten):
--   kontur-services-dispatch      */5 * * * *   -> Edge Function kontur-services
--   investment-advisor-dispatch   */15 * * * *  -> Edge Function investment-advisor
--
-- Beide senden POST {action:'dispatch'} mit dem Header X-Kontur-Cron aus dem
-- Vault-Secret 'kontur_cron_secret'. Die Commands entsprechen exakt dem
-- Live-Stand (aus cron.job ausgelesen).
--
-- Idempotenz: Bestehende Jobs werden zuerst per cron.unschedule entfernt.
-- Der Aufruf ist in einen guarded DO-Block gefasst (exception when others),
-- damit die Migration auch auf einer frischen Umgebung ohne vorhandene Jobs
-- fehlerfrei durchläuft. Anschließend legt cron.schedule die Jobs mit dem
-- identischen Command wieder an. Mehrfaches Anwenden ist dadurch harmlos.
--
-- Einmaliges Secret-Setup (manuell, NICHT Teil dieser Migration):
--   select vault.create_secret('<zufälliges Secret, mindestens 32 Zeichen>', 'kontur_cron_secret');
-- Das Secret muss zusätzlich als ADVISOR_CRON_SECRET in den Edge-Function-
-- Secrets hinterlegt sein.
-- ============================================================================

-- pg_cron liegt auf Supabase im Schema pg_catalog, pg_net stellt net.http_post
-- bereit. Beide Extensions sind im Dashboard bzw. hier zu aktivieren.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Bestehende Jobs entfernen (guarded: kein Fehler, falls nicht vorhanden)
do $guard$
begin
  perform cron.unschedule('kontur-services-dispatch');
exception when others then
  null;
end
$guard$;

do $guard$
begin
  perform cron.unschedule('investment-advisor-dispatch');
exception when others then
  null;
end
$guard$;

-- kontur-services: Dispatch alle 5 Minuten
select cron.schedule('kontur-services-dispatch', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://mubwhahgrxgungwtbwab.supabase.co/functions/v1/kontur-services',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Kontur-Cron', (select decrypted_secret from vault.decrypted_secrets where name = 'kontur_cron_secret')
    ),
    body := jsonb_build_object('action', 'dispatch'),
    timeout_milliseconds := 100000
  );
$job$);

-- investment-advisor: Dispatch alle 15 Minuten
select cron.schedule('investment-advisor-dispatch', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://mubwhahgrxgungwtbwab.supabase.co/functions/v1/investment-advisor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Kontur-Cron', (select decrypted_secret from vault.decrypted_secrets where name = 'kontur_cron_secret')
    ),
    body := jsonb_build_object('action', 'dispatch'),
    timeout_milliseconds := 100000
  );
$job$);
