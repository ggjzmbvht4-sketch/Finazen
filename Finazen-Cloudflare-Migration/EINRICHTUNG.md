# Kontur — Einrichtung mit GitHub Pages und Cloudflare

Stand: 21.11.2026. Diese Anleitung beschreibt den Zweig `cloudflare-migration`.

## Architektur

- **Frontend:** GitHub Pages unter https://ggjzmbvht4-sketch.github.io/Finazen/
- **Backend:** Cloudflare Worker `kontur-cloud`
- **Worker-Adresse:** https://kontur-cloud.ggjzmbvht4-kontur.workers.dev
- **Datenbank:** Cloudflare D1, Datenbank `kontur-db`, EU-Jurisdiktion
- **Private Berichtsdateien:** Cloudflare R2, Bucket `kontur-reports`
- **Hintergrundjobs:** Cloudflare Cron Triggers
- **E-Mail:** optional Resend für Konto-Bestätigung und Passwort-Wiederherstellung

Die bisherige Supabase-Version bleibt im Bestandscode erhalten und wird durch die Einrichtung der Cloudflare-Version nicht verändert. Der Worker stellt nur die benötigten Auth-, Plan- und Function-Endpunkte bereit; es gibt keinen öffentlichen generischen D1-Tabellen- oder RPC-Zugriff.

## 1. Voraussetzungen

Für lokale Prüfungen und das Deployment werden benötigt:

- Node.js 24 oder neuer
- ein Cloudflare-Konto mit Zugriff auf das vorhandene Konto
- Berechtigungen für Workers, D1, R2 und Workers-Secrets
- für GitHub Actions entsprechende Repository-Secrets

Abhängigkeiten installieren und bei Cloudflare anmelden:

```sh
npm ci
npx wrangler login
```

Die D1-Datenbank ist bereits in `wrangler.jsonc` eingetragen:

```text
Datenbankname: kontur-db
Datenbank-ID: 1da27e76-e5b4-443a-9408-8f89881bbefd
Binding: DB
```

## 2. R2 einmalig im Dashboard aktivieren

Die erstmalige R2-Aktivierung kann nicht zuverlässig über die allgemeine Cloudflare-API erfolgen. Falls R2 im Konto noch nicht aktiviert ist:

1. Cloudflare Dashboard öffnen.
2. **R2 Object Storage** auswählen und die Produktaktivierung einschließlich etwaiger Zahlungs-/Nutzungsbestätigung abschließen.
3. Einen privaten Bucket mit dem exakten Namen **`kontur-reports`** erstellen.
4. Als Standort beziehungsweise Jurisdiktion **EU** wählen, sofern die Oberfläche diese Auswahl anbietet.
5. Keine öffentliche Bucket-URL und keine Public Buckets-Funktion aktivieren.

Das Binding `REPORTS` ist bereits in `wrangler.jsonc` vorgesehen. Ohne aktiviertes R2 und ohne diesen Bucket können Authentifizierung und D1 grundsätzlich funktionieren, der Berichtsspeicher und ein vollständiges Deployment mit R2-Binding jedoch nicht.

## 3. D1-Schema anwenden

Die Migration ist idempotent über Wranglers Migrationsverwaltung ausgelegt und muss vor dem produktiven Start angewendet werden:

```sh
npm run db:migrate:remote
```

Den angezeigten SQL-Umfang und die Ziel-Datenbank `kontur-db` prüfen, bevor die Anwendung bestätigt wird. Danach kann der Tabellenstand kontrolliert werden:

```sh
npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

## 4. Worker-Secrets setzen

Secrets niemals in `wrangler.jsonc`, `.dev.vars`, Git oder Tickets speichern. Die folgenden Befehle fragen den Wert interaktiv ab; er wird nicht im Repository abgelegt.

### Für den Cron-Schutz und verschlüsselte Integrationsdaten

```sh
openssl rand -hex 32 | npx wrangler secret put ADVISOR_CRON_SECRET
openssl rand -hex 32 | npx wrangler secret put INTEGRATION_SECRETS_KEY
```

Beide Werte werden zufällig erzeugt und direkt an Wrangler übergeben, ohne im Terminal sichtbar zu werden. `ADVISOR_CRON_SECRET` muss mindestens 32 Zeichen haben. `INTEGRATION_SECRETS_KEY` verschlüsselt benutzerbezogene Integrationsdaten und Wikifolio-Sitzungen; ein späterer Wechsel macht zuvor verschlüsselte Daten unlesbar.

### Broker und Abrechnung

| Secret | Zweck |
|---|---|
| `TRADING212_API_KEY` | Live-API-Schlüssel aus Trading212 |
| `TRADING212_API_SECRET` | Zugehöriges Trading212-Secret |
| `TRADING212_OWNER_ID` | UUID des persönlichen Kontur-Kontos; bindet Brokerzugriff, Advisor und gemeinsames API-Budget an dieses Konto |

Der Trading212-Schlüssel benötigt nur die tatsächlich genutzten Rechte, typischerweise `account`, `portfolio`, `metadata`, `pies:read` und — nur bei ausdrücklich gewünschter Zielpflege — `pies:write`. Keine IP-Beschränkung auf eine lokale Adresse setzen, da die Anfragen von Cloudflare ausgehen. Die App löst keine einzelnen Wertpapierorders aus.

Die Benutzer-ID kann nach der ersten Registrierung vom Kontoinhaber aus D1 gelesen werden:

```sh
npx wrangler d1 execute DB --remote --command "SELECT id,email,created_at FROM auth_users ORDER BY created_at"
npx wrangler secret put TRADING212_OWNER_ID
```

### KI und Marktdaten

| Secret | Status / Zweck |
|---|---|
| `OPENROUTER_API_KEY` | Für Advisor-, Strategie-, Budget- und Berichts-KI erforderlich |
| `FINNHUB_API_KEY` | Optional für US-Fundamentaldaten und Nachrichten |
| `TWELVE_DATA_API_KEY` | Optional für zusätzliche Kursdaten |
| `FINANCIAL_DATASETS_API_KEY` | Nur für den Marktdatenmodus `free_then_paid`; im Standard `free_only` nicht erforderlich |

Jedes benötigte Secret einzeln setzen, beispielsweise:

```sh
npx wrangler secret put OPENROUTER_API_KEY
```

Die Modelle können ohne Secret über `OPENROUTER_MODEL`, `OPENROUTER_ADVISOR_MODEL` und `OPENROUTER_REPORT_MODEL` angepasst werden. Nicht angegebene spezialisierte Modelle fallen auf `OPENROUTER_MODEL` zurück.

### Optionale Wikifolio-Anbindung

```sh
npx wrangler secret put WIKIFOLIO_EMAIL
npx wrangler secret put WIKIFOLIO_PASSWORD
npx wrangler secret put WIKIFOLIO_SESSION_ENCRYPTION_KEY
```

`WIKIFOLIO_SESSION_ENCRYPTION_KEY` ist optional, wenn `INTEGRATION_SECRETS_KEY` gesetzt ist. Kein Wikifolio-Konto mit ungeeignetem Mehrfaktor-Ablauf verwenden; die Anbindung ist lesend.

### Optionale E-Mails über Resend

| Secret | Zweck |
|---|---|
| `RESEND_API_KEY` | API-Schlüssel eines verifizierten Resend-Projekts |
| `RESEND_FROM` | Verifizierte Absenderadresse, zum Beispiel `Kontur <kontur@example.org>` |

Ohne beide Werte werden neue Konten automatisch bestätigt. In diesem Modus kann die App keine Passwort-Recovery-E-Mail versenden. Sind beide Werte gesetzt, ist nach der Registrierung eine Bestätigungs-E-Mail erforderlich und die Passwort-Wiederherstellung verwendet einen sechsstelligen, eine Stunde gültigen Code.

## 5. Worker deployen und prüfen

```sh
npm run check
npm run build
npm test
npm run deploy
```

Danach Gesundheit und CORS prüfen:

```sh
curl https://kontur-cloud.ggjzmbvht4-kontur.workers.dev/health
```

Erwartet wird eine JSON-Antwort mit `"ok":true`. Anschließend in der App:

1. https://ggjzmbvht4-sketch.github.io/Finazen/ öffnen.
2. Unter **Einstellungen → Verbindungen** muss die oben genannte Worker-Adresse eingetragen sein; ein Publishable Key ist nicht erforderlich.
3. Konto mit E-Mail und Passwort anlegen.
4. Plan speichern, Seite neu laden und den Cloud-Stand kontrollieren.
5. Gewünschte Broker-, Marktdaten- und Advisor-Verbindungstests ausführen.
6. Eine kleine TXT- oder durchsuchbare PDF-Datei im Berichtsspeicher hochladen, herunterladen und wieder löschen.
7. Eine KI-Analyse nur mit einem unkritischen Testdokument prüfen, bevor vertrauliche Berichte verwendet werden.

## 6. Zeitpläne und Aufbewahrung

`wrangler.jsonc` richtet zwei Cron Trigger ein:

- **Alle fünf Minuten:** Broker-/Markt-Dispatch und fällige Advisor-Aufgaben; zusätzlich Bereinigung abgelaufener Leases und Caches.
- **Täglich um 03:17 UTC:** zusätzlich Retention alter technischer Lauf-, Job-, Kosten- und Auth-Datensätze.

Die eigentliche Advisor-Häufigkeit wird weiterhin durch dessen Fälligkeit und Profile gesteuert. Nach dem Deployment die Trigger im Cloudflare Dashboard kontrollieren. Cron-Aufrufe protokollieren Fehler in den Workers-Logs, ohne Secrets auszugeben.

## 7. Lokale Entwicklung

Lokale D1- und R2-Emulation verwenden:

```sh
npm run db:migrate:local
npm run dev
```

Für lokale Geheimnisse kann eine nicht versionierte `.dev.vars` angelegt werden. Die Datei ist durch `.gitignore` ausgeschlossen. Ohne Resend ist die automatische Konto-Bestätigung auch lokal aktiv.

Die Tests starten einen eigenen lokalen Worker und decken Auth, Owner-Trennung, Plan-Konflikte, portierte Finanz- und Advisor-Handler, Refresh-Rotation, TXT/PDF über R2, nachvollziehbare KI-Fehler sowie Reset und Kontolöschung ab.

## 8. App auf iPhone und Mac verwenden

- **iPhone:** App-Adresse in Safari öffnen → Teilen → **Zum Home-Bildschirm**.
- **Mac:** App-Adresse im Browser öffnen oder in Safari über **Ablage → Zum Dock hinzufügen** installieren.

Die PWA bleibt offline mit dem letzten lokalen Stand nutzbar. Cloud-Funktionen benötigen eine Verbindung zum Worker.

## 9. Kosten, Datenschutz und Betrieb

- Für GitHub Pages und Cloudflare gelten die jeweiligen aktuellen Kontingente, Preise und Nutzungsbedingungen; R2 kann eine einmalige Kontoaktivierung mit Zahlungsdaten verlangen.
- OpenRouter und gegebenenfalls Financial Datasets verursachen zusätzliche API-Kosten. Die App reserviert und verrechnet diese über ihr Kostenbudget; ein unklarer Provider-Abbruch kann als unsicherer Kostenposten geführt werden.
- Berichtsdateien sind auf 8 MB pro Datei, 50 MB privaten Gesamtspeicher, vier Dokumente und 16 MB je Analyse begrenzt.
- Vor einer Berichtsanalyse Dokumente auf vertrauliche oder personenbezogene Inhalte prüfen. Der ausgewählte extrahierte Text wird an OpenRouter übertragen.
- Datenschutzerklärung und Risikohinweise sind in der App verlinkt. Die Platzhalter für die verantwortliche Person in `datenschutz.html` müssen vor einer Bereitstellung für Dritte ersetzt werden.
- Supabase erst nach erfolgreicher produktiver Verifikation und gesonderter Freigabe stilllegen oder löschen. Die Cloudflare-Migration selbst nimmt keine destruktiven Supabase-Änderungen vor.
