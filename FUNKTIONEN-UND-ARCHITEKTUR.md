# Kontur (Finazen) — Funktionen und Architektur

Vollständige Bestandsaufnahme der App und des Cloudflare-Backends.
Stand: Code auf `main` (Merge der Cloudflare-Migration, PR #1).

---

## 1. Überblick

**Kontur** ist eine deutschsprachige Progressive Web App (PWA) für private
Finanzplanung, Portfolio-Verwaltung, Beteiligungen und einen KI-gestützten
Robo-Advisor ("Wealth"). Alle Beträge werden in EUR geführt und intern als
Integer-Cent (`engine.js: cents()`) verarbeitet.

- **Frontend:** statische PWA auf GitHub Pages —
  `https://ggjzmbvht4-sketch.github.io/Finazen/` (`index.html`, `app.js`, ~30 ES-Module)
- **Backend:** Cloudflare Worker `kontur-cloud` —
  `https://kontur-cloud.ggjzmbvht4-kontur.workers.dev` (`cloudflare/*.ts`, `wrangler.jsonc`)
- **Datenbank:** Cloudflare D1 `kontur-db` (EU), Schema in `migrations/0001_initial.sql`
- **Dateispeicher:** Cloudflare R2 Bucket `kontur-reports` (EU, privat) für Berichtsdateien
- **Hintergrundverarbeitung:** zwei Cron Trigger (`*/5 * * * *` und `17 3 * * *`)
- **Lokaler Modus:** ohne Anmeldung arbeitet die App vollständig lokal
  (localStorage `kontur-plan-v1:<userId>`) und bleibt dank Service Worker offline nutzbar

Die alte Supabase-Variante liegt noch als Bestand im Repo (`supabase/`,
`Finazen-Cloudflare-Migration/`), ist aber nicht mehr aktiv. Der Worker
bietet keinen öffentlichen generischen Tabellen-/RPC-Zugriff, sondern nur
ausgewählte Endpunkte.

---

## 2. Frontend: Ansichten und Navigation

Hash-Routing (`#/view[/YYYY-MM]`), definiert in `app.js:33-35`:

| Ansicht | Zweck |
|---|---|
| `home` — Übersicht | Dashboard: "Als Nächstes"-Aufgaben, Liquiditätsverlauf des Jahres, Portfolio-Karte |
| `month` — Monatsplan | Alle Zahlungen eines Monats, Filter nach Typ, Suche, Ist-Buchungen ("gebucht" ersetzt Planbetrag nur für diesen Monat) |
| `year` — Jahresblick | Liquiditätsverlauf des gewählten Jahres, Monat-für-Monat-Tabelle, CSV-Export |
| `reserves` — Jahresplan / Rücklagen | Rücklagen-Karten mit Kontostand, Ziel, Fortschritt, verknüpften Rechnungen, Sparraten |
| `plan-details` — Budgets und Rücklagen | Budget-Umschläge (siehe §3) |
| `investments` — Portfolio | Vermögensübersicht, Assets, Buchungen, Kurse, Treemap/Verteilung |
| `wealth` — Robo-Advisor | Strategien, Mandate, KI-Modelle, tatsächliche Broker-Bestände, Pie-Steuerung |
| `strategy-setup` — Strategie einrichten | Strategiedefinierung (Designer) |
| `settings` — Einstellungen | Tabs: Darstellung, Finanzplanung, Verbindungen (Cloudflare/Konto), Automatik, Datenverwaltung |

Weitere UI-Bausteine: Schnell-Erfassung (`workbench.js`, `data-work="quick"`),
Broker-Import (`broker`), Budget-Kauf, Ausgaben-Regel, Umbuchung Plan↔Portfolio
(`to-plan`, `to-pf`, `budget-buy`, `expense-rule`). Modale Dialoge über ein
globales `<dialog>`, Toasts, Suche mit Debounce.

Einstellungen-Tabs (`app.js:85`):
- **Darstellung** — Theme (hell/dunkel), Akzent, Dichte etc.
- **Finanzplanung** — Planungsgrundlage: Name, Planungsbeginn (Anchor-Monat), Anfangsguthaben
- **Verbindungen** — Cloudflare-Worker-URL konfigurieren, Konto anlegen/anmelden,
  abmelden, Passwort-Wiederherstellung, Plan hochladen/laden (Cloud-Sync)
- **Automatik** — Integrationen: Trading212, OpenRouter/Marktdaten, Wikifolio,
  Pie-Zuordnungen, Task-Fehler, Kostenbudget (siehe §6)
- **Datenverwaltung** — Excel-Import, CSV-Export, Backup (JSON-Download),
  Demo-Daten, Import-Hinweise, Kontur-Daten zurücksetzen, Konto endgültig löschen,
  App-Update/Installation (PWA)

---

## 3. Finanzplanung (Kern-Engine `engine.js`, `planning.js`, `savings.js`, `cash.js`)

**Datenmodell** (`emptyState()`, `engine.js:9`): ein Plan-Objekt
`{schema, name, anchor, openingCash, entries[], reserves[], actuals{}, notes[], portfolio, updatedAt}`.

- **Einträge** (`TYPES`): `income` (Einnahmen), `expense` (Fixkosten),
  `budget` (Budgets), `investment` (Investments), `reserve` (Rücklagenraten)
- **Häufigkeiten** (`FREQUENCIES`): einmalig, monatlich, quartalsweise,
  halbjährlich, jährlich; Start-/Endmonat, Fälligkeitstag, Pending-Flag,
  Monats-Overrides (`planOverrides`)
- **Ist-Buchungen** (`actuals`): Schlüssel `entryId:YYYY-MM`, Betrag + bei
  Budgets einzelne Positionen (Einkäufe) mit Pending-Markierung
- **Rücklagen** (`reserves`): Name, Zweck, Konto, Anfangsbestand, Zielbetrag,
  Zieldatum; Raten reservieren Geld innerhalb der Liquidität, verknüpfte
  Ausgaben entnehmen daraus
- **Budgets (Umschlagverfahren)** (`planning.js`): Rest wird monatsübergreifend
  mitgeführt (`carries`), Ist-Käufe werden vom Budget abgezogen
- **Prognose-Engine** (`project()`): rollt Monate vom Anchor bis max. 50 Jahre,
  Modi `plan` / `forecast` / `actual` (+ Szenario-Delta auf Einnahmen, Ausgaben,
  Investments); berechnet freie Liquidität = Kasse − Rücklagen − Budget-Reste
- **Validierung** (`validateState()`): strikte Typ-/Range-Prüfung des gesamten
  Plans inkl. Portfolio; korrupte lokale Daten werden erkannt und als
  "Originaldatei herunterladen" angeboten

**Import/Export:**
- Excel-Import (`.xlsx` via `importer.js: readXlsx/fromWorkbook`), CSV-Import
  von Broker-Abrechnungen (`broker-import.js`), CSV-Export des Jahres
  (`csvExport`), JSON-Backup/Restore des kompletten Plans
- Demo-Datensatz zum Ausprobieren
- Import-Hinweise (`notes`) nach Broker-Import

---

## 4. Portfolio und Investments (`portfolio.js`, `trading.js`, `history.js`, `wealth-visuals.js`)

- **Asset-Typen** (`KINDS`): Aktie, ETF, Fonds/NAO, Anleihe, Trading212-Pie,
  Private Beteiligung, Alternative Anlage, Investment-Cash
- **Ereignisse** (`EVENT_TYPES`): Einzahlung/Kauf, Auszahlung/Verkauf,
  Dividende/Ausschüttung, Gebühr, Bestandsabgleich — mit Datum, Betrag,
  Gebühren, Quelle (`SOURCES`: manuell, Anbieter/Abrechnung, geschätzt),
  Verknüpfung zu Plan-Einträgen (`planSourceKey`) und Cash-Bewegungen
- **Bestände** (`trading.js`): `holdingAt()` berechnet Stückzahlen aus Trades,
  `reconcileHoldings()`, Zielgewichte (`setTargets`), Cash-Verwaltung
  (Ein-/Auszahlungen beim Pie-Cash, `cash.js`)
- **Kurse/Quotes**: historische Kurse, `latestQuote()`, FX-bereinigte
  Cashflows in EUR-Cent
- **Beteiligungen**: Bewertungsgrundlagen (`report-core.js`: Beteiligungstyp,
  Quote %, Forderung, Fälligkeit, Prüfvermerk) mit kanonischem SHA-256-Hash
- **Visualisierung**: Vermögensverlauf (`historyChart`), Projektion
  (`modelProjection`), Treemap, Spartiel-Anzeige
- **Historie**: letzte 90 Tage bewerteter Tagesstände (`history.js`)

---

## 5. Robo-Advisor / Wealth (`managed-core.js`, `strategy-designer.js`, `advisor-ui.js`, `managed-ui.js`)

- **Anlagestrategien** im Plan (`state.strategies`): Name, Ansatz
  (passiv/aktiv), Risikoprofil, Sektor-/Währungsziele, Einzelpositions-Cap
- **Mandat v2** (`managed-core.js: mandate()`): Zielgewichte in Basispunkten,
  Core-Sleeve-Regel, Handelskosten je Instrument (25 bps Aktie, 10 bps sonst,
  +15 bps Fremdwährung)
- **Modell-Allokation** (`allocateModel()`): verteilt das Vermögen auf das
  Aktienuniversum, `drift()` erkennt Abweichungen, `depositDue()` plant
  Einzahlungen
- **Wealth-Status/-Historie**: serverseitige Vermögensmodelle
  (`wealth_models`, `wealth_cache`) mit Verlauf (`v12_broker_days`)
- **Pie-Steuerung** (Trading212): jeder importierte Pie erhält eine Zuordnung
  — `advisor` (KI-Modell), `mirror` (Wikifolio-Spiegelung) oder `manual`
  (nur lesen). Zielpflege wird erst nach einer Vorschau (`preview-pie`)
  separat freigegeben (`enable-control`); Schreibvorgänge laufen als
  `pie-write`-Tasks mit Lease und Hash-Prüfung (`begin/finish_v12_pie_write`).
  Externe Änderungen am Pie werden als Konflikt erkannt und pausieren die
  Steuerung (`PIE_CONFLICT`)

---

## 6. Integrationen und KI (Backend `cloudflare/kontur-services.ts`, `investment-advisor.ts`)

Alle Integrationen laufen serverseitig im Worker; Schlüssel liegen als
Worker-Secrets oder verschlüsselt pro Benutzer (`v12_integration_secrets`,
verschlüsselt mit `INTEGRATION_SECRETS_KEY`):

- **Trading212 Live-API**: Konto, Positionen, Pies, Instrumente werden getrennt
  synchronisiert (`broker`, `broker-account`, `broker-positions`, `broker-pies`,
  `broker-instruments`-Tasks). Erforderliche Rechte: `account`, `portfolio`,
  `metadata`, `pies:read`, optional `pies:write`. Rechterprüfung ohne
  Order-Auslösung (`test-broker`), Rate-Limit-Schutz pro Endpunkt
  (`claim_v12_broker_rate`). Die App löst keine Einzelorders aus; Pies werden
  über Zielgewichte (`pie-write`) gepflegt.
- **Wikifolio-Spiegelung** (`mirror`): öffentliche Seite wird geprüft, bei
  Bedarf serverseitiger Login mit `WIKIFOLIO_EMAIL`/`WIKIFOLIO_PASSWORD`
  (Sitzungs-Cookie verschlüsselt in `v12_wikifolio_sessions`); Captcha/2FA
  pausieren die Quelle. Vordefinierte Quellen: Szew Grundinvestment
  (`WF00SZEW01`), AlphaStars (`WFCAPITALA`).
- **Marktdaten**: Modus `free_only` (Yahoo-Kursreihen, kostenlose
  Fundamentaldaten) oder `free_then_paid` (Fallback auf Financial Datasets).
  Optional Finnhub (Nachrichten/US-Fundamentaldaten) und Twelve Data.
  Aufgaben: `market-index` (wöchentlich), `market-screen` (Batches à 25 ISINs),
  `market-deep` (Vertiefungsanalysen). Bewertung über Sektor-Perzentilen
  (`rank_v12_market`: ROE, KGV, Verschuldung, Wachstum, Momentum → Score/100)
  mit Status `mapped/analysed/incomplete/unmapped/stale`.
- **OpenRouter-KI**: Advisor-Läufe (`run`), Strategiebudget-Entwürfe
  (`budget-draft`), Berichtanalysen. Modell per `OPENROUTER_MODEL` /
  `OPENROUTER_ADVISOR_MODEL` / `OPENROUTER_REPORT_MODEL`
  (Default `anthropic/claude-haiku-5.5`).
- **Kostenbudget** (`v12_cost_events`): 30 €/Monat gesamt, davon max. 25 €
  Marktdaten und 5 € KI; Reservierung → Abrechnung (`settled`/`released`/
  `uncertain`) via `reserve_v12_cost`/`settle_v12_cost`/`v12_budget_status`.

Advisor-Aktionen (`/functions/v1/investment-advisor`): `list`, `save-profile`,
`run`, `adopt`, `market`, `search-market`, `budget-draft`, `wealth-status`,
`wealth-history`, `activate-wealth`, `pause-wealth` plus cron-`dispatch`
(fällige Profile, max. 5 pro Lauf, 100-s-Zeitbudget, Zombie-Reaper).

Kontur-Services-Aktionen (`/functions/v1/kontur-services`): `status`,
`save-keys`, `delete-keys`, `test-ai`, `enable-broker`/`disable-broker`,
`test-broker`, `set-market-mode`, `set-sync-interval` (5/10/15/60/1440 min),
`assign-pie`, `bind-pie`, `preview-pie`, `enable-control`, `remove-control`,
`research`, `start-market`, `save-source`, `probe-source`, `delete-source`,
`delete-strategy`, `retry-task` plus cron-`dispatch` (Task-Worker, 80-s-Budget).

---

## 7. Berichte und Dokumentenanalyse (`investment-reports.ts`, `report-store.js`, `reports-ui.js`)

- **Upload** privater Dokumente in den R2-Bucket `kontur-reports`
  (Schlüssel `reports/<owner>/<id>/<datei>`): PDF, TXT, MD; Limits
  (`report-core.js: LIMITS`): 8 MB pro Datei, 4 Dokumente, 50 MB Gesamtspeicher,
  16 MB je Analyse, 120.000 Zeichen extrahierter Text
- **KI-Analyse** (`analyse`): PDF-Textextraktion serverseitig (`unpdf`),
  TXT/MD direkt; der extrahierte Text wird zusammen mit der Bewertungsgrundlage
  eines Investments an OpenRouter gesendet; Ergebnis mit Basis-Hash in
  `report_analyses` gespeichert (Audit-Nachvollziehbarkeit)
- **Aktionen**: `list`, `upload`, `analyse`, `download`, `delete-document`, `adopt`
  (Analyseergebnis als Bewertungsgrundlage übernehmen)

---

## 8. Cloudflare-Worker: Endpunkte und Sicherheit

`cloudflare/index.ts` (Router), Konfiguration `wrangler.jsonc`:

| Endpunkt | Funktion |
|---|---|
| `GET /health` | Gesundheitscheck inkl. D1-Ping → `{"ok":true}` |
| `POST /auth/v1/signup` | Registrierung (E-Mail + Passwort ≥ 8 Zeichen, PBKDF2-SHA-256, 100.000 Iterationen); mit Resend-Secrets Bestätigungs-E-Mail, sonst Auto-Confirm |
| `POST /auth/v1/token?grant_type=password` | Login → Access-Token (1 h) + Refresh-Token (30 Tage), beide nur als SHA-256 in `auth_sessions` |
| `POST /auth/v1/token?grant_type=refresh_token` | Refresh-Rotation: alter Refresh-Token wird gelöscht (alte Sitzung ungültig) |
| `GET/PUT /auth/v1/user` | Profildaten / Passwort ändern (löscht andere Sitzungen) |
| `POST /auth/v1/logout` | Sitzung beenden |
| `POST /auth/v1/recover` + `POST /auth/v1/verify` | Passwort-Reset per 6-stelligem Code (1 h gültig) via Resend |
| `GET /auth/v1/confirm` | E-Mail-Bestätigungslink → Redirect zur App |
| `DELETE /auth/v1/admin/users/:id` | nur mit internem apikey (Kontolöschung) |
| `GET /rest/v1/finance_plans` | eigener Plan lesen — `owner_id` wird serverseitig auf den Token-Owner gezwungen |
| `POST /rest/v1/rpc/save_finance_plan` | optimistisches Speichern mit `expected_revision` → `SYNC_CONFLICT` (409) bei Abweichung |
| `POST /functions/v1/kontur-services` | Integrationen (siehe §6) |
| `POST /functions/v1/investment-advisor` | Advisor (siehe §6) |
| `POST /functions/v1/account-tools` | `status`, `reset` (alle Kontodaten löschen), `delete`, `delete-account` (Passwort + "LÖSCHEN"-Phrase erforderlich) |
| `POST /functions/v1/investment-reports` | Berichte (siehe §7) |

Interne RPCs (`/rest/v1/rpc/*`, nur über internen Fetch erreichbar):
`save_finance_plan`, `claim_v12_task`, `finish_v12_task`, `enqueue_v12_task`,
`enqueue_v12_deep`, `enqueue_v12_screens`, `claim_v12_broker_rate`,
`v12_budget_status`, `v12_coverage`, `reserve_v12_cost`, `settle_v12_cost`,
`rank_v12_market`, `begin/finish_v12_pie_write`, `save_v12_binding`,
`remove_v12_control`, `delete_v12_strategy`, `claim_advisor_profile`.

**Sicherheit:**
- CORS: nur `ALLOWED_ORIGINS` (GitHub-Pages-Origin), `Vary: Origin`, `Cache-Control: no-store`
- Der generische REST-Zugriff (`db.ts: rest()`) ist auf eine Whitelist von 20
  Tabellen beschränkt, mit strenger Identifier-/Filter-Validierung; DELETE ohne
  Filter verboten; JSON-/Boolean-Spalten werden typisiert dekodiert
- Interne Aufrufe laufen über `https://kontur.internal` mit `apikey:
  cloudflare-internal` und sind von außen nicht erreichbar
- Billing-Owner-Gate: mit `TRADING212_OWNER_ID` ist der Worker auf ein
  persönliches Konto beschränkt
- Fehlermeldungen werden bereinigt (Bearer-Tokens entfernt, auf 500 Zeichen
  gekürzt); Secrets stehen nie im Repo
- Cron-Dispatch erfordert `X-Kontur-Cron`-Header mit `ADVISOR_CRON_SECRET`
  (timing-sicherer SHA-256-Vergleich, ≥ 32 Zeichen)

**Cron-Jobs** (`wrangler.jsonc: triggers`): alle 5 Minuten Broker-/Markt-Dispatch
+ fällige Advisor-Profile + Lease-Reaper; täglich 03:17 UTC zusätzlich Retention
(advisor_runs 366 Tage, advisor_jobs 731 Tage, cost_events 396 Tage, abgelaufene
Caches/Sessions/Token).

**D1-Schema** (`migrations/0001_initial.sql`, 20 Tabellen): `auth_users`,
`auth_sessions`, `auth_verification_tokens`, `finance_plans`, `v12_preferences`,
`v12_broker_state`, `v12_broker_pies`, `v12_pie_bindings`, `v12_mirror_sources`,
`v12_tasks`, `v12_instruments`, `v12_broker_days`, `v12_cost_events`,
`wealth_cache`, `wealth_models`, `advisor_profiles`, `v12_wikifolio_sessions`,
`advisor_jobs`, `advisor_runs`, `v12_integration_secrets`, `report_documents`,
`report_analyses`.

**Client-seitige Cloud-Schicht** (`cloud.js`): Worker-URL konfigurieren
(nur HTTPS-Origin ohne Pfad), Session in localStorage (`kontur-session-v1`)
mit automatischem Refresh, Fehler-Mapping auf deutsche Meldungen
(Anmeldung abgelaufen, Sync-Konflikt etc.), Sync: `load()` liest
`finance_plans`, `save()` schreibt per RPC mit Revision.

---

## 9. PWA, Offline, Updates

- `manifest.webmanifest` + Icons (SVG/192/512), installierbar auf iPhone
  (Safari → "Zum Home-Bildschirm") und Mac (Safari → Dock)
- Service Worker `sw.js` (Cache `kontur-v13.0.0-cloudflare`): App-Shell wird
  gecacht, Navigationen network-first mit Cache-Fallback, Assets
  cache-first mit Hintergrund-Aktualisierung → offline nutzbar mit lokalem Stand
- Update-Banner bei neuem SW (`SKIP_WAITING`), manuelle Update-Prüfung
  (`check-update`) in den Einstellungen
- CSP in `index.html`: `connect-src` nur eigener Origin + Worker-Domain

---

## 10. Rechtliches und Datenschutz

- Footer in der App: "Private Software — keine Anlageberatung" mit Links zu
  `datenschutz.html` (Datenschutzerklärung, Platzhalter für Verantwortlichen)
  und `risikohinweise.html`
- R2-Bucket privat, EU-Jurisdiktion; verschlüsselte Integrationsdaten;
  Wikifolio-Anbindung rein lesend; keine 2FA-Speicherung
- KI-Analyse: nur ausgewählter extrahierter Text geht an OpenRouter

---

## 11. Entwicklung, Tests, Betrieb

`package.json`-Scripts: `dev` (wrangler lokal), `check` (tsc), `build`
(dry-run deploy), `test` (`node --test tests/worker.test.mjs` — lokaler Worker,
deckt Auth, Owner-Trennung, Plan-Konflikte, Handler, Refresh-Rotation, R2
TXT/PDF, KI-Fehler, Reset/Kontolöschung ab), `db:migrate:local/remote`, `deploy`.
Setup und Secrets siehe `EINRICHTUNG.md`; Secrets-Übersicht in
`supabase/SECRETS.md` (Bestand).
