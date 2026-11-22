import { userFromRequest, verifyCredentials } from './auth';
import { all, batch, decodeRow, first, json, now, run } from './db';

const DATA_TABLES = [
  'advisor_jobs','advisor_runs','v12_tasks','v12_cost_events','v12_pie_bindings',
  'v12_broker_pies','v12_broker_state','v12_broker_days','v12_instruments',
  'v12_mirror_sources','v12_wikifolio_sessions','v12_preferences','wealth_models',
  'wealth_cache','advisor_profiles','v12_integration_secrets','report_analyses',
  'report_documents',
];

class ToolError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function safeMessage(value: unknown) {
  return String(value || 'Unbekannter Fehler').replace(/Bearer\s+\S+/gi, 'Bearer [entfernt]').replace(/[\r\n]+/g, ' ').slice(0, 400);
}

function berlinMonth() {
  const parts = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return get('year') + '-' + get('month');
}

function emptyPlan() {
  return {
    schema: 1, name: 'Meine Finanzplanung', anchor: berlinMonth(), openingCash: 0,
    entries: [], reserves: [], actuals: {}, notes: [],
    portfolio: { version: 1, assets: [], instruments: [], events: [], quotes: [], compositions: [], snapshots: [] },
    updatedAt: now(),
  };
}

function deleteInvestmentFromPlan(plan: any, id: string, keepChildren = false) {
  const next = structuredClone(plan), portfolio = next.portfolio || {};
  const assets = Array.isArray(portfolio.assets) ? portfolio.assets : [];
  const asset = assets.find((item: any) => item.id === id);
  if (!asset) throw new ToolError('Investment nicht gefunden.', 404);
  const ids = new Set([id]);
  if (asset.kind === 'pie') {
    for (const child of assets.filter((item: any) => item.parentId === id)) {
      if (keepChildren) { child.parentId = ''; child.targetBps = 0; } else ids.add(child.id);
    }
  }
  portfolio.assets = assets.filter((item: any) => !ids.has(item.id));
  const events = Array.isArray(portfolio.events) ? portfolio.events : [];
  const removedTrades = new Set(events.filter((item: any) => ids.has(item.assetId)).map((item: any) => item.id));
  portfolio.events = events.filter((item: any) => !ids.has(item.assetId));
  for (const event of portfolio.events) {
    if (ids.has(event.cashAssetId)) delete event.cashAssetId;
    if (removedTrades.has(event.linkedTradeId)) {
      delete event.linkedTradeId;
      event.note = 'Historische Cash-Bewegung · Investment entfernt';
    }
  }
  const used = new Set(portfolio.assets.map((item: any) => item.instrumentId).filter(Boolean));
  portfolio.instruments = (Array.isArray(portfolio.instruments) ? portfolio.instruments : []).filter((item: any) => used.has(item.id));
  portfolio.quotes = (Array.isArray(portfolio.quotes) ? portfolio.quotes : []).filter((item: any) => !ids.has(item.assetId) && (!item.instrumentId || used.has(item.instrumentId)));
  portfolio.compositions = (Array.isArray(portfolio.compositions) ? portfolio.compositions : []).filter((item: any) => !ids.has(item.pieId));
  if (next.dividends) next.dividends = next.dividends.filter((item: any) => !ids.has(item.assetId));
  next.portfolio = portfolio;
  next.updatedAt = now();
  return next;
}

async function cancelPendingWork(env: any, owner: string) {
  await batch(env, [
    { sql: "UPDATE v12_tasks SET status='cancelled',updated_at=? WHERE owner_id=? AND status IN ('queued','running','blocked')", values: [now(), owner] },
    { sql: "UPDATE advisor_jobs SET status='failed',error='Konto zurückgesetzt oder gelöscht; Lauf abgebrochen.',finished_at=? WHERE owner_id=? AND status IN ('queued','running')", values: [now(), owner] },
  ]);
}

async function deleteReportObjects(env: any, owner: string) {
  if (!env.REPORTS) return;
  let cursor: string | undefined;
  do {
    const page: any = await env.REPORTS.list({ prefix: owner + '/', cursor, limit: 500 });
    const keys = (page.objects || []).map((object: any) => object.key);
    for (let offset = 0; offset < keys.length; offset += 100) await env.REPORTS.delete(keys.slice(offset, offset + 100));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function removeUserData(env: any, owner: string, includeAccount: boolean) {
  await cancelPendingWork(env, owner);
  const statements = DATA_TABLES.map((table) => ({ sql: `DELETE FROM ${table} WHERE owner_id=?`, values: [owner] }));
  if (includeAccount) statements.push({ sql: 'DELETE FROM auth_users WHERE id=?', values: [owner] });
  await batch(env, statements);
  await deleteReportObjects(env, owner);
}

async function loadPlan(env: any, owner: string, value: unknown) {
  const row: any = await first(env, 'SELECT data,revision FROM finance_plans WHERE owner_id=?', [owner]);
  const expected = Number(value);
  if (!Number.isSafeInteger(expected) || expected < 0) throw new ToolError('SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.', 409);
  if (!row) {
    if (expected !== 0) throw new ToolError('SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.', 409);
    return null;
  }
  if (Number(row.revision) !== expected) throw new ToolError('SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.', 409);
  return { data: JSON.parse(row.data), revision: Number(row.revision) };
}

function requirePassword(data: any, phrase: string) {
  if (data.confirmed !== true || data.phrase !== phrase) throw new ToolError(`Bitte zur Bestätigung ${phrase} eingeben.`);
  if (typeof data.password !== 'string' || !data.password) throw new ToolError('Bitte das aktuelle Passwort eingeben.');
}

export function createAccountToolsHandler(env: any) {
  return async (request: Request) => {
    if (request.method !== 'POST') return json({ error: 'Nur POST' }, 405);
    try {
      if (Number(request.headers.get('Content-Length') || 0) > 65536) throw new ToolError('Anfrage ist zu groß.', 413);
      const user = await userFromRequest(env, request);
      if (!user) throw new ToolError('Bitte erneut anmelden.', 401);
      let data: any;
      try { data = await request.json(); } catch { throw new ToolError('Ungültige Anfrage.'); }
      const owner = user.id;

      if (data.action === 'status') {
        const task = await first(env, "SELECT id FROM v12_tasks WHERE owner_id=? AND status IN ('queued','running') LIMIT 1", [owner]);
        const plan: any = await first(env, 'SELECT revision,updated_at FROM finance_plans WHERE owner_id=?', [owner]);
        return json({ pending: Boolean(task), revision: plan?.revision ?? null, updatedAt: plan?.updated_at ?? null });
      }

      if (data.action === 'reset') {
        requirePassword(data, 'ZURÜCKSETZEN');
        if (!await verifyCredentials(env, user.email, data.password)) throw new ToolError('Das Passwort wurde nicht bestätigt.', 403);
        const plan = await loadPlan(env, owner, data.planRevision), next = emptyPlan(), revision = (plan?.revision || 0) + 1;
        if (plan) {
          const updated: any = await all(env, 'UPDATE finance_plans SET data=?,revision=?,updated_at=? WHERE owner_id=? AND revision=? RETURNING revision', [next, revision, now(), owner, plan.revision]);
          if (!updated.length) throw new ToolError('SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.', 409);
        } else {
          await run(env, 'INSERT INTO finance_plans(owner_id,data,revision,updated_at) VALUES(?,?,?,?)', [owner, next, revision, now()]);
        }
        await removeUserData(env, owner, false);
        return json({ data: next, revision });
      }

      if (data.action === 'delete') {
        if (data.confirmed !== true) throw new ToolError('Bitte die Löschbestätigung vollständig eingeben.');
        if (typeof data.assetId !== 'string' || !/^[\w-]{1,80}$/.test(data.assetId)) throw new ToolError('Investment fehlt.');
        const plan = await loadPlan(env, owner, data.planRevision);
        if (!plan) throw new ToolError('Kein Finanzplan vorhanden.', 404);
        const next = deleteInvestmentFromPlan(plan.data, data.assetId, data.keepChildren === true), revision = plan.revision + 1;
        const updated: any = await all(env, 'UPDATE finance_plans SET data=?,revision=?,updated_at=? WHERE owner_id=? AND revision=? RETURNING revision', [next, revision, now(), owner, plan.revision]);
        if (!updated.length) throw new ToolError('SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.', 409);
        return json({ data: next, revision });
      }

      if (data.action === 'delete-account') {
        requirePassword(data, 'LÖSCHEN');
        if (!await verifyCredentials(env, user.email, data.password)) throw new ToolError('Das Passwort wurde nicht bestätigt.', 403);
        await removeUserData(env, owner, true);
        return json({ deleted: true });
      }
      throw new ToolError('Unbekannte Aktion.');
    } catch (error: any) {
      return json({ error: safeMessage(error?.message) }, error instanceof ToolError ? error.status : 400);
    }
  };
}
