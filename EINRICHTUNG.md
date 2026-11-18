# Kontur V12.1 — Einrichtungsanleitung

Stand: 19.11.2026. Die App läuft unter **https://ggjzmbvht4-sketch.github.io/Finazen/** — das Backend (Supabase-Projekt `kontur`, Frankfurt/eu-central-1) ist vollständig eingerichtet: Datenbank-Schema (Migrationen 001–014), drei Edge Functions (`kontur-services`, `investment-advisor`, `account-tools`) und zwei Hintergrund-Zeitpläne (pg_cron: Broker/Markt alle 5 Minuten, Robo-Advisor alle 15 Minuten).

Damit alles live geht, musst du nur noch die folgenden **Secrets** einmalig hinterlegen. Das geht ohne Werkzeuge im Browser:

**Supabase-Dashboard → Projekt „kontur“ → Edge Functions → Secrets** (https://supabase.com/dashboard/project/mubwhahgrxgungwtbwab/settings/functions)

## 1. Pflicht-Secrets

| Secret | Wert / Quelle |
|---|---|
| `ADVISOR_CRON_SECRET` | `1858bb07cb5f1ccb7641039c8d54a8de196ef5cc68816ce0c8345fc1828a6206` — aktiviert die beiden Hintergrund-Zeitpläne (dieser Wert liegt bereits verschlüsselt in der Datenbank-Vault und muss exakt so auch als Function-Secret gesetzt werden) |
| `ALLOWED_ORIGINS` | `https://ggjzmbvht4-sketch.github.io` — damit die App die Functions aufrufen darf |
| `TRADING212_API_KEY` | Neuer **Live**-API-Schlüssel aus der Trading212-App (Einstellungen → API) mit den Rechten `account`, `portfolio`, `metadata`, `pies:read`, `pies:write`. Wichtig: keine IP-Beschränkung eintragen (Supabase hat wechselnde IPs) |
| `TRADING212_API_SECRET` | Das Secret zum Trading212-Schlüssel |
| `TRADING212_OWNER_ID` | Deine Kontur-Benutzer-ID — siehe Schritt 3 unten |
| `OPENROUTER_API_KEY` | Schlüssel von openrouter.ai (für KI-Anlagekommentare, Analysen, Budget-Entwürfe; Kosten sind in der App auf 30 €/Monat gedeckelt) |

## 2. Optionale Secrets

| Secret | Zweck |
|---|---|
| `WIKIFOLIO_EMAIL` + `WIKIFOLIO_PASSWORD` | Wikifolio-Spiegelung (Szew Grundinvestment WF00SZEW01 und AlphaStars WFCAPITALA sind vorbereitet). Nur lesend, kein 2FA-Konto verwenden |
| `WIKIFOLIO_SESSION_ENCRYPTION_KEY` | Beliebige Zeichenkette mit mindestens 16 Zeichen (verschlüsselt die Wikifolio-Sitzung) |
| `FINNHUB_API_KEY` | Kostenlose US-Fundamentaldaten und Nachrichten |
| `FINANCIAL_DATASETS_API_KEY` | Nur nötig, wenn du in den Einstellungen den Marktdatenmodus auf `free_then_paid` umstellst. Im Standard (`free_only`) **nicht** erforderlich |

## 3. Erste Schritte in der App

1. App öffnen: https://ggjzmbvht4-sketch.github.io/Finazen/
2. **Einstellungen → Verbindungen**: Supabase-URL und Schlüssel sind bereits voreingetragen → nur noch „Verbindung speichern“.
3. Konto anlegen (E-Mail + Passwort) und anmelden.
4. Deine Benutzer-ID finden: Supabase-Dashboard → Authentication → Users → deine UUID kopieren → als Secret `TRADING212_OWNER_ID` hinterlegen.
5. In der App: **Einstellungen → Verbindungen → „Broker-Rechte prüfen“** (test-broker). Die App zeigt pro Bereich an, ob Rechte fehlen — ein fehlendes Recht blockiert die übrigen Bereiche nicht.
6. Danach erscheinen deine Trading212-Pies automatisch mit ihren echten Namen im Portfolio. Pro Pie wählst du: **Advisor** (Kontur-Strategie), **Wikifolio** (Quelle auswählen) oder **Manuell**. Erst nach Zuordnung → Vorschau → ausdrücklicher Freigabe pflegt die App Zielgewichte automatisch. Echte Orders löst die App niemals aus.

## 4. Auf dem iPhone als App (PWA)

1. Safari öffnen → https://ggjzmbvht4-sketch.github.io/Finazen/
2. Teilen-Symbol → **„Zum Home-Bildschirm“** → Hinzufügen
3. Die App startet danach im Vollbild wie eine native App und funktioniert offline mit dem letzten Datenstand. Updates kommen automatisch (die App meldet „App-Update verfügbar“).

## 5. Auf dem Mac

Einfach die GitHub-Pages-Adresse im Browser öffnen (oder ebenfalls als App installieren: Safari → Ablage → „Zum Dock hinzufügen“). Desktop- und Mobilansicht sind beide angepasst.

## Hinweise

- **Rechtliches**: Datenschutzerklärung und Risikohinweise sind in der App verlinkt (Fußzeile und Einstellungen → Rechtliches). Die App ist ein privates Modellwerkzeug und keine Anlageberatung.
- **Kontolöschung**: Einstellungen → Datenverwaltung löscht alle Daten DSGVO-konform (inkl. Auth-Konto).
- **Kosten**: Supabase Free Tier (0 €), GitHub Pages (0 €). Kostenpflichtig ist nur OpenRouter (KI) und optional Financial Datasets — beide mit Budget-Deckel.
- Bei Problemen zuerst in der App unter Verbindungen den Broker- und Wikifolio-Verbindungstest ausführen; dort werden konkrete Fehlerursachen (fehlende Rechte, Rate-Limits, IP-Sperren) genannt.
