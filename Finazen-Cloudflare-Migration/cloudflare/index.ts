import { auth, userFromRequest } from './auth';
import { fail, first, json, rest } from './db';
import { createServicesHandler } from './kontur-services';
import { createHandler } from './investment-advisor';
import { createAccountToolsHandler } from './account-tools';
import { createReportsHandler } from './investment-reports';
import { reapAndRetain, rpc, saveFinancePlan } from './rpc';

const INTERNAL_ORIGIN = 'https://kontur.internal';
const INTERNAL_KEY = 'cloudflare-internal';
const DEFAULT_APP_URL = 'https://ggjzmbvht4-sketch.github.io/Finazen/';

function allowedOrigins(env: any) {
  const configured = String(env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return configured.length ? configured : [new URL(String(env.APP_URL || DEFAULT_APP_URL)).origin];
}

function originAllowed(env: any, request: Request) {
  const origin = request.headers.get('Origin') || '';
  return !origin || allowedOrigins(env).includes(origin);
}

function withCors(env: any, request: Request, response: Response) {
  const origin = request.headers.get('Origin') || '';
  if (!origin || !allowedOrigins(env).includes(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Headers', 'authorization,apikey,content-type,x-client-info,x-kontur-cron');
  headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Cache-Control', 'no-store');
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function serviceConfig(env: any) {
  return {
    url: INTERNAL_ORIGIN,
    serviceKey: INTERNAL_KEY,
    allowedOrigins: allowedOrigins(env),
    enforceBudget: true,
    billingOwner: env.TRADING212_OWNER_ID || '',
    brokerOwner: env.TRADING212_OWNER_ID || '',
    brokerKey: env.TRADING212_API_KEY || '',
    brokerSecret: env.TRADING212_API_SECRET || '',
    datasetsKey: env.FINANCIAL_DATASETS_API_KEY || '',
    newsKey: env.FINNHUB_API_KEY || '',
    openrouterKey: env.OPENROUTER_API_KEY || '',
    model: env.OPENROUTER_ADVISOR_MODEL || env.OPENROUTER_MODEL || 'anthropic/claude-haiku-5.5',
    twelveDataKey: env.TWELVE_DATA_API_KEY || '',
    cronSecret: env.ADVISOR_CRON_SECRET || '',
    secretsKey: env.INTEGRATION_SECRETS_KEY || env.WIKIFOLIO_SESSION_ENCRYPTION_KEY || '',
    wikifolioEmail: env.WIKIFOLIO_EMAIL || '',
    wikifolioPassword: env.WIKIFOLIO_PASSWORD || '',
    wikifolioSessionKey: env.WIKIFOLIO_SESSION_ENCRYPTION_KEY || '',
  };
}

function internalFetch(env: any) {
  return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const raw = input instanceof Request ? input.url : String(input);
    if (!raw.startsWith(INTERNAL_ORIGIN + '/')) return fetch(input, init);
    const url = new URL(raw);
    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
    if (!url.pathname.startsWith('/auth/') && headers.get('apikey') !== INTERNAL_KEY && headers.get('Authorization') !== 'Bearer ' + INTERNAL_KEY) {
      return json({ message: 'Interner Datenbankzugriff nicht autorisiert.' }, 401);
    }
    let body: any;
    if (init.body && String(headers.get('Content-Type') || '').includes('application/json')) {
      try { body = JSON.parse(String(init.body)); } catch { return json({ message: 'Ungültige interne Anfrage.' }, 400); }
    }
    const internalRequest = new Request(url, { method, headers, body: init.body });
    if (url.pathname.startsWith('/auth/v1/')) return auth(env, internalRequest, url.pathname);
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = decodeURIComponent(url.pathname.slice('/rest/v1/rpc/'.length));
      return rpc(env, name, body || {});
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      return rest(env, url.pathname.slice('/rest/v1/'.length) + url.search, method, body);
    }
    return json({ message: 'Interner Endpunkt nicht gefunden.' }, 404);
  };
}

async function publicRequest(env: any, request: Request, handlers: any) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/health' && request.method === 'GET') {
    await first(env, 'SELECT 1 AS ok');
    return json({ ok: true, service: 'kontur-cloudflare' });
  }
  if (path.startsWith('/auth/v1/admin/')) return json({ error: 'Endpunkt nicht gefunden.' }, 404);
  if (path.startsWith('/auth/v1/')) return auth(env, request, path);
  if (path === '/rest/v1/finance_plans' && request.method === 'GET') {
    const user = await userFromRequest(env, request);
    if (!user) return json({ message: 'Bitte erneut anmelden.', code: 'AUTH_REQUIRED' }, 401);
    const scoped = new URL(url);
    scoped.searchParams.delete('owner_id');
    scoped.searchParams.set('owner_id', 'eq.' + user.id);
    return rest(env, 'finance_plans' + scoped.search, 'GET');
  }
  if (path === '/rest/v1/rpc/save_finance_plan' && request.method === 'POST') {
    const user = await userFromRequest(env, request);
    if (!user) return json({ message: 'Bitte erneut anmelden.', code: 'AUTH_REQUIRED' }, 401);
    let body: any;
    try { body = await request.json(); } catch { return json({ message: 'Ungültige Anfrage.' }, 400); }
    if (!body?.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) return json({ message: 'Ungültiger Finanzplan.' }, 400);
    return json(await saveFinancePlan(env, user.id, body.payload, Number(body.expected_revision)));
  }
  if (path === '/functions/v1/kontur-services') return handlers.services(request);
  if (path === '/functions/v1/investment-advisor') return handlers.advisor(request);
  if (path === '/functions/v1/account-tools') return handlers.account(request);
  if (path === '/functions/v1/investment-reports') return handlers.reports(request);
  return json({ error: 'Endpunkt nicht gefunden.' }, 404);
}

function makeHandlers(env: any) {
  const config = serviceConfig(env);
  const fetcher = internalFetch(env);
  return {
    services: createServicesHandler(config, fetcher),
    advisor: createHandler(config, fetcher),
    account: createAccountToolsHandler(env),
    reports: createReportsHandler(env),
  };
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    if (!originAllowed(env, request)) return json({ error: 'ALLOWED_ORIGINS prüfen.' }, 403);
    if (request.method === 'OPTIONS') {
      return withCors(env, request, new Response(null, { status: 204 }));
    }
    try {
      const response = await publicRequest(env, request, makeHandlers(env));
      return withCors(env, request, response);
    } catch (error: any) {
      const status = Number(error?.status) || 500;
      const message = String(error?.message || 'Interner Serverfehler.').replace(/Bearer\s+\S+/gi, 'Bearer [entfernt]').replace(/[\r\n]+/g, ' ').slice(0, 500);
      return withCors(env, request, json({ error: message, message }, status));
    }
  },

  async scheduled(event: ScheduledEvent, env: any, ctx: ExecutionContext) {
    const work = async () => {
      const handlers = makeHandlers(env);
      const dispatch = () => new Request(INTERNAL_ORIGIN + '/functions/v1/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kontur-Cron': String(env.ADVISOR_CRON_SECRET || '') },
        body: JSON.stringify({ action: 'dispatch' }),
      });
      const results = await Promise.allSettled([
        handlers.services(dispatch()),
        handlers.advisor(dispatch()),
        reapAndRetain(env, event.cron.startsWith('17 3 ')),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') console.error('Scheduled task failed', String(result.reason));
        else if (result.value instanceof Response && !result.value.ok) console.error('Scheduled dispatch failed', result.value.status);
      }
    };
    ctx.waitUntil(work());
  },
};
