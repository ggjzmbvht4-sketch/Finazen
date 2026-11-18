# Secrets und Umgebungsvariablen der Edge Function `kontur-services`

Alle Variablen werden ausschließlich im Bundle-Entrypoint gelesen
(`supabase/functions/kontur-services.ts`, Modul `__module0`, Abschnitt
`// supabase/functions/kontur-services/index.ts`).
Gesetzt werden sie als Supabase-Edge-Function-Secrets:
Dashboard → Edge Functions → `kontur-services` → Secrets
(oder `supabase secrets set NAME=WERT`).

| Variable | Pflicht? | Zweck im Code |
|---|---|---|
| `SUPABASE_URL` | Pflicht (von Supabase automatisch gesetzt) | `env.url` – Basis für REST (`/rest/v1/`) und GoTrue (`/auth/v1/user`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Pflicht (automatisch) | `env.serviceKey` – apikey/Bearer für REST-RPCs und User-Verifikation |
| `ALLOWED_ORIGINS` | Pflicht für Browser-Aufrufe | Kommagetrennte Origin-Liste; ohne Match → 403 `ALLOWED_ORIGINS prüfen.` |
| `TRADING212_OWNER_ID` | Pflicht | `billingOwner` + `brokerOwner`; `enforceBudget:true` lehnt sonst mit `BILLING_OWNER`/`BROKER_SETUP` ab; muss der User-ID (UUID) des persönlichen Kontos entsprechen |
| `TRADING212_API_KEY` | Optional, aber Voraussetzung für alle Broker-Funktionen | Trading212-Live-Key (Basic Auth) |
| `TRADING212_API_SECRET` | Optional, wie Key | Trading212-Live-Secret (Basic Auth) |
| `FINANCIAL_DATASETS_API_KEY` | Optional | Paid-Fallback (`market_data_mode = free_then_paid`), sonst `DATA_SETUP` |
| `FINNHUB_API_KEY` | Optional | Kostenlose Fundamentaldaten/News für US-Titel (`env.newsKey`) |
| `OPENROUTER_API_KEY` | Pflicht für KI-Aktionen (`test-ai`, `market-deep`) | OpenRouter-Key; sonst `AI_KEY_MISSING` |
| `OPENROUTER_ADVISOR_MODEL` | Optional | Überschreibt das KI-Modell |
| `OPENROUTER_MODEL` | Optional | Fallback für Modell-Override; Default `anthropic/claude-haiku-5.5` |
| `ADVISOR_CRON_SECRET` | Pflicht für den Cron-Dispatch | Mind. 32 Zeichen; Vergleich mit Header `X-Kontur-Cron`; sonst 401 |
| `WIKIFOLIO_EMAIL` | Optional (Wikifolio-Spiegelung) | Login; sonst `SOURCE_SETUP` |
| `WIKIFOLIO_PASSWORD` | Optional (Wikifolio-Spiegelung) | Login; sonst `SOURCE_SETUP` |
| `WIKIFOLIO_SESSION_ENCRYPTION_KEY` | Pflicht für Wikifolio-Spiegelung | Mind. 16 Zeichen; AES-GCM (SHA-256 abgeleitet) für die Session-Cookies |

## Cron-Einrichtung (pg_cron + pg_net)

Der Hintergrund-Dispatcher ist der Endpunkt `action: "dispatch"`:

- **URL:** `https://mubwhahgrxgungwtbwab.supabase.co/functions/v1/kontur-services`
- **Methode:** `POST`, Body `{"action":"dispatch"}`
- **Auth:** Header `X-Kontur-Cron: <ADVISOR_CRON_SECRET>` (kein Supabase-JWT;
  die Function ist bewusst mit `verify_jwt = false` deployt, weil sie User-JWTs
  selbst gegen `/auth/v1/user` prüft und der Dispatch über das Cron-Secret läuft)

Der pg_cron-Job `kontur-services-dispatch` läuft alle 5 Minuten
(`*/5 * * * *`) und ruft per `net.http_post` den Dispatch-Endpunkt auf.
Das Secret liegt einmalig in der Supabase Vault unter dem Namen
`kontur_cron_secret` und wird zur Laufzeit aus `vault.decrypted_secrets`
gelesen (nicht im Klartext im Job-SQL).

**Wichtig:** Der Vault-Wert und das Edge-Function-Secret `ADVISOR_CRON_SECRET`
müssen identisch sein. Den Vault-Wert einmalig auslesen:

```sql
select decrypted_secret from vault.decrypted_secrets where name = 'kontur_cron_secret';
```

Diesen Wert als Function-Secret setzen:

```bash
supabase secrets set ADVISOR_CRON_SECRET=<Wert aus der Vault>
```

Rotation: neuen Wert per `vault.create_secret(...)` bzw. Update in der Vault
hinterlegen und dasselbe Secret erneut per `supabase secrets set` setzen.

## Smoke-Test ohne Auth (erwartetes Verhalten)

```bash
# Ohne Origin/Auth → 403
 curl -X POST https://mubwhahgrxgungwtbwab.supabase.co/functions/v1/kontur-services \
  -H 'Content-Type: application/json' -d '{"action":"status"}'

# Dispatch ohne X-Kontur-Cron → 401 {"error":"Nicht autorisiert"}
 curl -X POST https://mubwhahgrxgungwtbwab.supabase.co/functions/v1/kontur-services \
  -H 'Content-Type: application/json' -d '{"action":"dispatch"}'
```
