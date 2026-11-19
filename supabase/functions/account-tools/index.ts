import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ============================================================================
// Kontur account-tools: Kontodaten zurücksetzen, einzelnes Investment aus dem
// Cloud-Plan löschen und das gesamte Konto löschen (DSGVO Recht auf Löschung).
//
// Vertrag mit features-ui.js:
//   status          -> { pending: boolean }            (vor reset/delete geprüft)
//   reset           -> { data, revision }              (alle Kontodaten löschen,
//                                                       Anmeldung bleibt erhalten;
//                                                       Passwort + Phrase ZURÜCKSETZEN)
//   delete          -> { data, revision }              (ein Investment aus dem
//                                                       Cloud-Plan entfernen)
//   delete-account  -> { deleted: true }               (Daten + Auth-User löschen;
//                                                       Passwort + Phrase LÖSCHEN)
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || SERVICE_KEY;
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",").map((x) => x.trim()).filter(Boolean);
// K6 (E1/S1/S9): fail-closed mit Default-Origin, damit die App auch ohne
// gesetztes ALLOWED_ORIGINS-Secret funktioniert.
const ORIGINS = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : ["https://ggjzmbvht4-sketch.github.io"];

// Alle Tabellen mit nutzereigenen Zeilen (owner_id), gemäß 001_base_schema.sql,
// 012_v12_1.sql und 014_advisor_jobs.sql, verifiziert gegen das Projekt.
// finance_plans wird je nach Aktion separat behandelt.
const DATA_TABLES = [
  "advisor_jobs",
  "advisor_runs",
  "v12_tasks",
  "v12_cost_events",
  "v12_pie_bindings",
  "v12_broker_pies",
  "v12_broker_state",
  "v12_broker_days",
  "v12_instruments",
  "v12_mirror_sources",
  "v12_wikifolio_sessions",
  "v12_preferences",
  "wealth_models",
  "wealth_cache",
  "advisor_profiles",
];

class ToolError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function safeMessage(value: unknown): string {
  return String(value || "Unbekannter Fehler")
    .replace(/Bearer\s+\S+/gi, "Bearer [entfernt]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 400);
}

async function db(path: string, method = "GET", body?: unknown) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let data: unknown = null;
  try { data = await response.json(); } catch { /* kein JSON */ }
  if (!response.ok) {
    const message = (data as { message?: string } | null)?.message || "Datenbank nicht erreichbar.";
    throw new ToolError(safeMessage(message), response.status >= 500 ? 502 : 400);
  }
  return data;
}

// Entspricht accountEmptyPlan() in account-core.js.
function emptyPlan() {
  return {
    schema: 1,
    name: "Meine Finanzplanung",
    anchor: new Date().toISOString().slice(0, 7),
    openingCash: 0,
    entries: [],
    reserves: [],
    actuals: {},
    notes: [],
    portfolio: { version: 1, assets: [], instruments: [], events: [], quotes: [], compositions: [], snapshots: [] },
    updatedAt: new Date().toISOString(),
  };
}

// Entspricht accountDeleteInvestment() in account-core.js (Cloud-Seite).
function deleteInvestmentFromPlan(plan: any, id: string, keepChildren = false) {
  const next = JSON.parse(JSON.stringify(plan));
  const p = next.portfolio || {};
  const assets = Array.isArray(p.assets) ? p.assets : [];
  const a = assets.find((x: any) => x.id === id);
  if (!a) throw new ToolError("Investment nicht gefunden.", 404);
  const ids = new Set([id]);
  if (a.kind === "pie") {
    for (const child of assets.filter((x: any) => x.parentId === id)) {
      if (keepChildren) { child.parentId = ""; child.targetBps = 0; } else ids.add(child.id);
    }
  }
  p.assets = assets.filter((x: any) => !ids.has(x.id));
  const events = Array.isArray(p.events) ? p.events : [];
  const removedTrades = new Set(events.filter((e: any) => ids.has(e.assetId)).map((e: any) => e.id));
  p.events = events.filter((e: any) => !ids.has(e.assetId));
  for (const e of p.events) {
    if (ids.has(e.cashAssetId)) delete e.cashAssetId;
    if (removedTrades.has(e.linkedTradeId)) {
      delete e.linkedTradeId;
      e.note = "Historische Cash-Bewegung · Investment entfernt";
    }
  }
  const used = new Set(p.assets.map((x: any) => x.instrumentId).filter(Boolean));
  p.instruments = (Array.isArray(p.instruments) ? p.instruments : []).filter((i: any) => used.has(i.id));
  p.quotes = (Array.isArray(p.quotes) ? p.quotes : []).filter((q: any) => !ids.has(q.assetId) && (!q.instrumentId || used.has(q.instrumentId)));
  p.compositions = (Array.isArray(p.compositions) ? p.compositions : []).filter((h: any) => !ids.has(h.pieId));
  if (next.dividends) next.dividends = next.dividends.filter((x: any) => !ids.has(x.assetId));
  next.portfolio = p;
  next.updatedAt = new Date().toISOString();
  return next;
}

// Passwort erneut prüfen über den dokumentierten GoTrue-Password-Grant.
// Kein Admin-Zugriff nötig; ein Fehlschlag erzeugt keine Sitzung in der App.
async function verifyPassword(email: string, password: string) {
  let response: Response;
  try {
    response = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new ToolError("Anmeldedienst nicht erreichbar. Bitte später erneut versuchen.", 502);
  }
  if (!response.ok) throw new ToolError("Das Passwort wurde nicht bestätigt.", 403);
}

async function removeUserData(owner: string) {
  for (const table of DATA_TABLES) {
    await db(table + "?owner_id=eq." + owner, "DELETE");
  }
}

// W6 (B3): Vor dem Zurücksetzen/Löschen alle laufenden und anhängigen
// Aufgaben einstellen, damit kein laufender Pie-Write nach dem Reset noch
// gegen den Broker schreibt.
async function cancelPendingWork(owner: string) {
  await db("v12_tasks?owner_id=eq." + owner + "&status=in.(queued,running,blocked)", "PATCH", { status: "cancelled", updated_at: new Date().toISOString() });
  await db("advisor_jobs?owner_id=eq." + owner + "&status=in.(queued,running)", "PATCH", { status: "failed", error: "Konto zurückgesetzt oder gelöscht; Lauf abgebrochen.", finished_at: new Date().toISOString() });
}

async function loadPlan(owner: string, planRevision: unknown) {
  const rows = await db("finance_plans?owner_id=eq." + owner + "&select=data,revision") as any[];
  const plan = rows[0] || null;
  const expected = Number(planRevision);
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new ToolError("SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.", 409);
  }
  if (!plan) {
    if (expected !== 0) throw new ToolError("SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.", 409);
    return null;
  }
  if (plan.revision !== expected) {
    throw new ToolError("SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.", 409);
  }
  return plan;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  const allowed = ORIGINS.includes(origin);
  const cors = {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Headers": "authorization,apikey,content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);
  if (!allowed) return json({ error: "ALLOWED_ORIGINS prüfen." }, 403);

  try {
    let data: any;
    try { data = await req.json(); } catch { throw new ToolError("Ungültige Anfrage."); }

    const auth = req.headers.get("Authorization") || "";
    if (!/^Bearer \S+$/.test(auth)) throw new ToolError("Bitte anmelden.", 401);
    const userResponse = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SERVICE_KEY, Authorization: auth },
      signal: AbortSignal.timeout(10000),
    });
    if (!userResponse.ok) throw new ToolError("Bitte erneut anmelden.", 401);
    const user = await userResponse.json();
    const owner = user?.id;
    if (!/^[0-9a-f-]{36}$/i.test(owner || "")) throw new ToolError("Ungültige Anmeldung.", 401);

    if (data.action === "status") {
      const tasks = await db("v12_tasks?owner_id=eq." + owner + "&status=in.(queued,running)&select=id&limit=1") as any[];
      const plans = await db("finance_plans?owner_id=eq." + owner + "&select=revision,updated_at&limit=1") as any[];
      return json({ pending: tasks.length > 0, revision: plans[0]?.revision ?? null, updatedAt: plans[0]?.updated_at ?? null });
    }

    if (data.action === "reset") {
      if (data.confirmed !== true) throw new ToolError("Bitte die Löschbestätigung vollständig eingeben.");
      if (data.phrase !== "ZURÜCKSETZEN") throw new ToolError("Bitte zur Bestätigung ZURÜCKSETZEN eingeben.");
      if (typeof data.password !== "string" || !data.password) throw new ToolError("Bitte das aktuelle Passwort eingeben.");
      await verifyPassword(String(user.email || ""), data.password);
      const plan = await loadPlan(owner, data.planRevision);
      await cancelPendingWork(owner);
      await removeUserData(owner);
      const next = emptyPlan();
      const revision = (plan?.revision || 0) + 1;
      if (plan) {
        // W7 (B4): Atomarer Revisions-PATCH — eine leere Ergebnismenge
        // bedeutet, der Cloud-Stand wurde zwischenzeitlich geändert.
        const rows = await db("finance_plans?owner_id=eq." + owner + "&revision=eq." + plan.revision, "PATCH", { data: next, revision, updated_at: new Date().toISOString() }) as any[];
        if (!rows?.length) throw new ToolError("SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.", 409);
      } else {
        await db("finance_plans?on_conflict=owner_id", "POST", { owner_id: owner, data: next, revision, updated_at: new Date().toISOString() });
      }
      return json({ data: next, revision });
    }

    if (data.action === "delete") {
      if (data.confirmed !== true) throw new ToolError("Bitte die Löschbestätigung vollständig eingeben.");
      if (typeof data.assetId !== "string" || !/^[\w-]{1,80}$/.test(data.assetId)) throw new ToolError("Investment fehlt.");
      const plan = await loadPlan(owner, data.planRevision);
      if (!plan) throw new ToolError("Kein Finanzplan vorhanden.", 404);
      const next = deleteInvestmentFromPlan(plan.data, data.assetId, data.keepChildren === true);
      const revision = plan.revision + 1;
      // W7 (B4): Atomarer Revisions-PATCH mit 409 bei veraltetem Stand.
      const rows = await db("finance_plans?owner_id=eq." + owner + "&revision=eq." + plan.revision, "PATCH", { data: next, revision, updated_at: new Date().toISOString() }) as any[];
      if (!rows?.length) throw new ToolError("SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.", 409);
      return json({ data: next, revision });
    }

    if (data.action === "delete-account") {
      if (data.confirmed !== true) throw new ToolError("Bitte die Löschbestätigung vollständig eingeben.");
      if (data.phrase !== "LÖSCHEN") throw new ToolError("Bitte zur Bestätigung LÖSCHEN eingeben.");
      if (typeof data.password !== "string" || !data.password) throw new ToolError("Bitte das aktuelle Passwort eingeben.");
      await verifyPassword(String(user.email || ""), data.password);
      // Zuerst laufende Aufgaben einstellen, dann alle Datenzeilen
      // entfernen, danach das Auth-Konto (Reihenfolge: DSGVO).
      await cancelPendingWork(owner);
      await removeUserData(owner);
      await db("finance_plans?owner_id=eq." + owner, "DELETE");
      const adminResponse = await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + owner, {
        method: "DELETE",
        headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY },
        signal: AbortSignal.timeout(15000),
      });
      if (!adminResponse.ok) throw new ToolError("Das Konto konnte nicht vollständig gelöscht werden. Bitte erneut versuchen.", 502);
      return json({ deleted: true });
    }

    throw new ToolError("Unbekannte Aktion.");
  } catch (e) {
    if (e instanceof ToolError) return json({ error: e.message }, e.status);
    return json({ error: safeMessage((e as Error)?.message) }, 400);
  }
});
