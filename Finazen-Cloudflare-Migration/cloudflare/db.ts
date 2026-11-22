const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*(?:->>?[A-Za-z_][A-Za-z0-9_]*)?$/;

export const JSON_COLUMNS: Record<string, Set<string>> = {
  finance_plans: new Set(['data']),
  v12_preferences: new Set(['connection','broker_capabilities']),
  v12_broker_state: new Set(['snapshot']),
  v12_broker_pies: new Set(['details','summary']),
  v12_pie_bindings: new Set(['pending_shares','last_error']),
  v12_mirror_sources: new Set(['snapshot','error']),
  v12_tasks: new Set(['payload','last_error','last_result']),
  v12_instruments: new Set(['listings','facts','score','deep_analysis']),
  v12_cost_events: new Set(['meta']),
  wealth_cache: new Set(['payload']),
  wealth_models: new Set(['model']),
  advisor_profiles: new Set(['profile','setup_error']),
  advisor_jobs: new Set(['result']),
  advisor_runs: new Set(['profile','result']),
  report_analyses: new Set(['result','document_ids','basis']),
};

export const BOOLEAN_COLUMNS: Record<string, Set<string>> = {
  v12_preferences: new Set(['broker_enabled']),
  v12_pie_bindings: new Set(['enabled']),
  v12_instruments: new Set(['active']),
  advisor_profiles: new Set(['enabled']),
};

const TABLES = new Set([
  'finance_plans','v12_preferences','v12_broker_state','v12_broker_pies',
  'v12_pie_bindings','v12_mirror_sources','v12_tasks','v12_instruments',
  'v12_broker_days','v12_cost_events','wealth_cache','wealth_models',
  'advisor_profiles','v12_wikifolio_sessions','advisor_jobs','advisor_runs',
  'v12_integration_secrets','report_documents','report_analyses',
]);

export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export const plusSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

export function json(value: unknown, status = 200, headers: Record<string,string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

export async function all(env: any, sql: string, values: unknown[] = []) {
  const result = await env.DB.prepare(sql).bind(...values.map(bindValue)).all();
  return result.results || [];
}

export async function first(env: any, sql: string, values: unknown[] = []) {
  return env.DB.prepare(sql).bind(...values.map(bindValue)).first();
}

export async function run(env: any, sql: string, values: unknown[] = []) {
  return env.DB.prepare(sql).bind(...values.map(bindValue)).run();
}

export async function batch(env: any, statements: Array<{sql:string,values?:unknown[]}>) {
  if (!statements.length) return [];
  return env.DB.batch(statements.map((s) => env.DB.prepare(s.sql).bind(...(s.values || []).map(bindValue))));
}

export function bindValue(value: unknown): any {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

export function decodeRow(table: string, row: any) {
  if (!row) return row;
  const out = { ...row };
  for (const key of JSON_COLUMNS[table] || []) {
    if (typeof out[key] === 'string') {
      try { out[key] = JSON.parse(out[key]); } catch { /* behalte ungültige Rohdaten */ }
    }
  }
  for (const key of BOOLEAN_COLUMNS[table] || []) {
    if (out[key] !== null && out[key] !== undefined) out[key] = Boolean(out[key]);
  }
  return out;
}

async function rows(env: any, table: string, sql: string, values: unknown[] = []) {
  return (await all(env, sql, values)).map((row) => decodeRow(table, row));
}

function column(field: string) {
  if (!FIELD.test(field)) fail('Ungültiges Datenfeld.');
  const [name, path] = field.split(/(->>?)/).length > 1
    ? [field.split(/->>?/)[0], field.split(/->>?/)[1]]
    : [field, ''];
  if (!IDENTIFIER.test(name) || (path && !IDENTIFIER.test(path))) fail('Ungültiges Datenfeld.');
  return path ? `json_extract("${name}", '$.${path}')` : `"${name}"`;
}

function scalar(value: string) {
  if (value === 'true') return 1;
  if (value === 'false') return 0;
  if (value === 'null') return null;
  return value;
}

function filter(field: string, raw: string): {sql:string,values:unknown[]} {
  const expr = column(field);
  if (raw === 'is.null' || raw === 'eq.null') return { sql: `${expr} IS NULL`, values: [] };
  if (raw === 'not.is.null' || raw === 'neq.null') return { sql: `${expr} IS NOT NULL`, values: [] };
  const match = /^(eq|neq|gt|gte|lt|lte|like|ilike|in)\.(.*)$/s.exec(raw);
  if (!match) fail('Ungültiger Datenfilter.');
  const [, op, input] = match;
  if (op === 'in') {
    const content = input.startsWith('(') && input.endsWith(')') ? input.slice(1,-1) : input;
    const items = content.length ? content.split(',').map((v) => scalar(v.replace(/^"|"$/g,''))) : [];
    if (!items.length) return { sql: '0', values: [] };
    return { sql: `${expr} IN (${items.map(() => '?').join(',')})`, values: items };
  }
  const operators: Record<string,string> = { eq:'=', neq:'!=', gt:'>', gte:'>=', lt:'<', lte:'<=', like:'LIKE', ilike:'LIKE' };
  const value = scalar(op === 'ilike' ? input.toLowerCase() : input);
  return { sql: `${op === 'ilike' ? 'LOWER(' + expr + ')' : expr} ${operators[op]} ?`, values: [value] };
}

function selectedColumns(raw: string | null) {
  if (!raw || raw === '*') return '*';
  const fields = raw.split(',').filter(Boolean);
  if (!fields.every((x) => IDENTIFIER.test(x))) fail('Ungültige Feldauswahl.');
  return fields.map((x) => `"${x}"`).join(',');
}

function orderBy(raw: string | null) {
  if (!raw) return '';
  const parts = raw.split(',').map((part) => {
    const [field, direction] = part.split('.');
    if (direction && !['asc','desc'].includes(direction)) fail('Ungültige Sortierung.');
    return `${column(field)}${direction === 'desc' ? ' DESC' : ' ASC'}`;
  });
  return ' ORDER BY ' + parts.join(',');
}

function whereFor(url: URL) {
  const reserved = new Set(['select','order','limit','offset','on_conflict']);
  const clauses: string[] = [], values: unknown[] = [];
  for (const [field, raw] of url.searchParams) {
    if (reserved.has(field)) continue;
    const parsed = filter(field, raw);
    clauses.push(parsed.sql); values.push(...parsed.values);
  }
  return { sql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', values };
}

function bodyRecord(body: any) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Ein Datensatz wird erwartet.');
  for (const key of Object.keys(body)) if (!IDENTIFIER.test(key)) fail('Ungültiges Datenfeld.');
  return body;
}

export async function rest(env: any, path: string, method: string, body?: any): Promise<Response> {
  try {
    const url = new URL('https://internal/' + path.replace(/^\/+/, ''));
    const table = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!TABLES.has(table)) fail('Unbekannte Datentabelle: ' + table, 404);
    if (method === 'GET') {
      const where = whereFor(url);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 1000), 0), 10000);
      const offset = Math.min(Math.max(Number(url.searchParams.get('offset') || 0), 0), 1000000);
      const sql = `SELECT ${selectedColumns(url.searchParams.get('select'))} FROM "${table}"${where.sql}${orderBy(url.searchParams.get('order'))} LIMIT ${limit} OFFSET ${offset}`;
      return json(await rows(env, table, sql, where.values));
    }
    if (method === 'POST') {
      const records = Array.isArray(body) ? body : [body];
      if (!records.length) return json([]);
      const output: any[] = [];
      for (const input of records) {
        const record = bodyRecord(input);
        if (['v12_tasks','v12_cost_events','advisor_jobs','advisor_runs','report_documents','report_analyses'].includes(table) && !record.id) record.id = uuid();
        const keys = Object.keys(record);
        if (!keys.length) fail('Leerer Datensatz.');
        const values = keys.map((key) => record[key]);
        const conflict = url.searchParams.get('on_conflict');
        let upsert = '';
        if (conflict) {
          const fields = conflict.split(',');
          if (!fields.every((x) => IDENTIFIER.test(x))) fail('Ungültiger Konfliktschlüssel.');
          const updates = keys.filter((key) => !fields.includes(key));
          upsert = ` ON CONFLICT(${fields.map((x) => `"${x}"`).join(',')}) DO ` + (updates.length
            ? 'UPDATE SET ' + updates.map((key) => `"${key}"=excluded."${key}"`).join(',')
            : 'NOTHING');
        }
        const result = await rows(env, table,
          `INSERT INTO "${table}" (${keys.map((x) => `"${x}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})${upsert} RETURNING *`,
          values,
        );
        output.push(...result);
      }
      return json(output, 201);
    }
    if (method === 'PATCH') {
      const record = bodyRecord(body), keys = Object.keys(record);
      if (!keys.length) fail('Keine Änderungen übergeben.');
      const where = whereFor(url);
      const result = await rows(env, table,
        `UPDATE "${table}" SET ${keys.map((key) => `"${key}"=?`).join(',')}${where.sql} RETURNING *`,
        [...keys.map((key) => record[key]), ...where.values],
      );
      return json(result);
    }
    if (method === 'DELETE') {
      const where = whereFor(url);
      if (!where.sql) fail('Löschen ohne Filter ist nicht erlaubt.');
      const result = await rows(env, table, `DELETE FROM "${table}"${where.sql} RETURNING *`, where.values);
      return json(result);
    }
    return json({ message: 'Methode nicht erlaubt.' }, 405);
  } catch (error: any) {
    const message = String(error?.message || 'Datenbankfehler.');
    const status = Number(error?.status) || (/UNIQUE constraint|constraint failed/i.test(message) ? 409 : 400);
    return json({ message: failSafeMessage(message), code: 'DATABASE_ERROR' }, status);
  }
}

export function failSafeMessage(message: string) {
  if (/UNIQUE constraint failed/i.test(message)) return 'Datensatz ist bereits vorhanden.';
  if (/FOREIGN KEY constraint failed/i.test(message)) return 'Verknüpfter Datensatz fehlt.';
  if (/CHECK constraint failed/i.test(message)) return 'Datensatz verletzt eine Gültigkeitsregel.';
  return message.replace(/[\r\n]+/g,' ').slice(0,500);
}
