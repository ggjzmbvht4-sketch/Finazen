-- 018_integration_secrets.sql
-- Zweck: Nutzer-eigene Integrations-Schlüssel (Trading212 API-Key/-Secret,
-- OpenRouter API-Key), die direkt in den App-Einstellungen eingegeben werden.
-- Inhalt: ausschließlich AES-256-GCM-Ciphertext (sealText in kontur-services;
-- Payload = JSON {t212Key, t212Secret, openrouterKey}, leere Felder fehlen).
-- Auflösung: App-Schlüssel haben Vorrang vor den Function-Secrets
-- (TRADING212_API_KEY/TRADING212_API_SECRET/OPENROUTER_API_KEY) — Fallback.
-- Zugriff ausschließlich über die Service-Role (keine Grants/Policies),
-- Muster exakt wie v12_wikifolio_sessions (012_v12_1.sql).
create table if not exists public.v12_integration_secrets (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  ciphertext text not null,
  nonce text not null,
  updated_at timestamptz not null default now()
);
alter table public.v12_integration_secrets enable row level security;
revoke all on table public.v12_integration_secrets from public, anon, authenticated;
