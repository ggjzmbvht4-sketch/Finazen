-- ============================================================================
-- Kontur V12.1 — Migration 016: Konfigurierbare Sync-Intervalle
-- Fügt public.v12_preferences.sync_interval_minutes hinzu.
-- Erlaubte Werte: 5, 10, 15, 60 Minuten sowie 1440 (= täglich, max. 1×/Tag).
-- Verwendung: kontur-services.ts (areaDelay/pieRefreshDelayMs, Action
--   'set-sync-interval'; gelesen u. a. über die Action 'status').
-- Idempotent: add column if not exists + drop/add der Check-Constraint.
-- ============================================================================

alter table public.v12_preferences
  add column if not exists sync_interval_minutes int not null default 5;

alter table public.v12_preferences drop constraint if exists v12_preferences_sync_interval_check;
alter table public.v12_preferences
  add constraint v12_preferences_sync_interval_check
  check (sync_interval_minutes in (5, 10, 15, 60, 1440));
