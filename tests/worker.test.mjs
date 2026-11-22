import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = process.env.WRANGLER_BIN || path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const base = 'http://127.0.0.1:8787';
const origin = 'https://ggjzmbvht4-sketch.github.io';
let worker, workerLog = '';

async function request(pathname, { method = 'GET', body, token, form, requestOrigin = origin } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      Origin: requestOrigin,
      apikey: 'cloudflare-public',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: form || (body === undefined ? undefined : JSON.stringify(body)),
  });
  const type = response.headers.get('Content-Type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  return { response, data };
}

function ok(result, status = 200) {
  assert.equal(result.response.status, status, JSON.stringify(result.data));
  return result.data;
}

function plan(name = 'Testplan') {
  return {
    schema: 1, name, anchor: '2026-11', openingCash: 0, entries: [], reserves: [], actuals: {}, notes: [],
    portfolio: {
      version: 1,
      assets: [{ id: 'asset-1', name: 'Testbeteiligung', kind: 'private', valuationMode: 'manual', planEntryIds: [], liquidity: 'long' }],
      instruments: [], events: [], quotes: [], compositions: [], snapshots: [],
    },
  };
}

function simplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 62 >>\nstream\nBT /F1 12 Tf 72 720 Td (Quartalsbericht Umsatz 100 EUR) Tj ET\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(base + '/health');
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Worker startete nicht:\n' + workerLog);
}

test('Cloudflare-Migration: Auth, D1, R2 und Kontolöschung', async (t) => {
  assert.ok(existsSync(wrangler), 'Wrangler wurde nicht gefunden.');
  const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local'], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' } });
  assert.equal(migration.status, 0, migration.stdout + migration.stderr);
  worker = spawn(process.execPath, [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', '8787'], { cwd: root, env: { ...process.env, CI: '1' } });
  worker.stdout.on('data', (chunk) => { workerLog = (workerLog + chunk).slice(-20000); });
  worker.stderr.on('data', (chunk) => { workerLog = (workerLog + chunk).slice(-20000); });
  t.after(async () => {
    if (!worker || worker.killed) return;
    worker.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => worker.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  });
  await waitForHealth();

  await t.test('Gesundheit, CORS und kein öffentlicher generischer REST-Zugriff', async () => {
    const health = ok(await request('/health'));
    assert.equal(health.ok, true);
    const denied = await request('/health', { requestOrigin: 'https://unbekannt.example' });
    assert.equal(denied.response.status, 403);
    const generic = await request('/rest/v1/v12_tasks?select=*');
    assert.equal(generic.response.status, 404);
    const admin = await request('/auth/v1/admin/users/' + crypto.randomUUID(), { method: 'DELETE' });
    assert.equal(admin.response.status, 404);
  });

  const emailA = `a-${crypto.randomUUID()}@example.test`, emailB = `b-${crypto.randomUUID()}@example.test`;
  let sessionA, sessionB, userA, userB;

  await t.test('Registrierung, Login und Owner-Trennung', async () => {
    const signup = ok(await request('/auth/v1/signup', { method: 'POST', body: { email: emailA, password: 'sehr-sicheres-passwort' } }), 201);
    assert.equal(signup.emailConfirmationRequired, false);
    assert.equal((await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: emailA, password: 'falsch-falsch' } })).response.status, 400);
    sessionA = ok(await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: emailA, password: 'sehr-sicheres-passwort' } }));
    userA = sessionA.user;
    assert.equal(ok(await request('/auth/v1/user', { token: sessionA.access_token })).id, userA.id);
    ok(await request('/auth/v1/signup', { method: 'POST', body: { email: emailB, password: 'noch-sichereres-passwort' } }), 201);
    sessionB = ok(await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: emailB, password: 'noch-sichereres-passwort' } }));
    userB = sessionB.user;
  });

  await t.test('Optimistische Plan-Synchronisation und Konflikt', async () => {
    const saved = ok(await request('/rest/v1/rpc/save_finance_plan', { method: 'POST', token: sessionA.access_token, body: { payload: plan(), expected_revision: 0 } }));
    assert.equal(saved.revision, 1);
    const loaded = ok(await request('/rest/v1/finance_plans?select=data,revision,updated_at&owner_id=eq.' + userA.id, { token: sessionA.access_token }));
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].data.portfolio.assets[0].id, 'asset-1');
    const conflict = await request('/rest/v1/rpc/save_finance_plan', { method: 'POST', token: sessionA.access_token, body: { payload: plan('Veraltet'), expected_revision: 0 } });
    assert.equal(conflict.response.status, 409);
    assert.match(conflict.data.message, /SYNC_CONFLICT/);
    assert.equal(ok(await request('/rest/v1/rpc/save_finance_plan', { method: 'POST', token: sessionA.access_token, body: { payload: plan(), expected_revision: 1 } })).revision, 2);
    ok(await request('/rest/v1/rpc/save_finance_plan', { method: 'POST', token: sessionB.access_token, body: { payload: plan('Anderes Konto'), expected_revision: 0 } }));
    const foreign = ok(await request('/rest/v1/finance_plans?select=owner_id,data,revision&owner_id=eq.' + userA.id, { token: sessionB.access_token }));
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0].owner_id, userB.id);
    assert.equal(foreign[0].data.name, 'Anderes Konto');
  });

  await t.test('Übernommene Finanz- und Advisor-Handler nutzen interne D1-Adapter', async () => {
    const services = ok(await request('/functions/v1/kontur-services', { method: 'POST', token: sessionA.access_token, body: { action: 'status' } }));
    assert.ok(Object.hasOwn(services, 'preferences'));
    assert.ok(services.budget);
    const advisor = ok(await request('/functions/v1/investment-advisor', { method: 'POST', token: sessionA.access_token, body: { action: 'list' } }));
    assert.ok(Array.isArray(advisor.runs));
  });

  await t.test('Refresh-Rotation macht alte Sitzung ungültig', async () => {
    const previousAccess = sessionA.access_token, previousRefresh = sessionA.refresh_token;
    sessionA = ok(await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: previousRefresh } }));
    assert.equal((await request('/auth/v1/user', { token: previousAccess })).response.status, 401);
    assert.equal((await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: previousRefresh } })).response.status, 400);
    assert.equal(ok(await request('/auth/v1/user', { token: sessionA.access_token })).id, userA.id);
  });

  let documentId;
  await t.test('R2-Upload, Listing, Download und nachvollziehbarer KI-Fehlerstatus', async () => {
    const form = new FormData();
    form.set('file', new File(['Quartalsbericht: Umsatz 100 EUR.'], 'bericht.txt', { type: 'text/plain' }));
    form.set('assetId', 'asset-1');
    form.set('reportDate', '2026-11-01');
    form.set('category', 'financial');
    const uploaded = ok(await request('/functions/v1/investment-reports', { method: 'POST', token: sessionA.access_token, form }), 201);
    documentId = uploaded.document.id;
    assert.equal(uploaded.document.asset_name, 'Testbeteiligung');
    const pdfForm = new FormData();
    pdfForm.set('file', new File([simplePdf()], 'bericht.pdf', { type: 'application/pdf' }));
    pdfForm.set('assetId', 'asset-1');
    pdfForm.set('reportDate', '2026-11-01');
    pdfForm.set('category', 'financial');
    const pdfUpload = ok(await request('/functions/v1/investment-reports', { method: 'POST', token: sessionA.access_token, form: pdfForm }), 201);
    const pdfDocumentId = pdfUpload.document.id;
    const listed = ok(await request('/functions/v1/investment-reports', { method: 'POST', token: sessionA.access_token, body: { action: 'list' } }));
    assert.equal(listed.documents.length, 2);
    assert.equal(listed.configuration.aiReady, false);
    const downloaded = await request('/functions/v1/investment-reports', { method: 'POST', token: sessionA.access_token, body: { action: 'download', documentId } });
    assert.equal(downloaded.response.status, 200);
    assert.equal(downloaded.data, 'Quartalsbericht: Umsatz 100 EUR.');
    const analysed = ok(await request('/functions/v1/investment-reports', { method: 'POST', token: sessionA.access_token, body: { action: 'analyse', requestId: crypto.randomUUID(), assetId: 'asset-1', documentIds: [documentId], planRevision: 2 } }));
    assert.equal(analysed.analysis.status, 'failed');
    assert.match(analysed.analysis.error, /OpenRouter/);
    ok(await request('/functions/v1/investment-reports', { method: 'POST', token: sessionA.access_token, body: { action: 'delete-document', documentId } }));
    ok(await request('/functions/v1/investment-reports', { method: 'POST', token: sessionA.access_token, body: { action: 'delete-document', documentId: pdfDocumentId } }));
    assert.equal((await request('/functions/v1/investment-reports', { method: 'POST', token: sessionA.access_token, body: { action: 'download', documentId } })).response.status, 404);
  });

  await t.test('Reset, Logout und vollständige Kontolöschung', async () => {
    assert.equal((await request('/functions/v1/account-tools', { method: 'POST', token: sessionA.access_token, body: { action: 'reset', confirmed: true, phrase: 'ZURÜCKSETZEN', password: 'falsch', planRevision: 2 } })).response.status, 403);
    const reset = ok(await request('/functions/v1/account-tools', { method: 'POST', token: sessionA.access_token, body: { action: 'reset', confirmed: true, phrase: 'ZURÜCKSETZEN', password: 'sehr-sicheres-passwort', planRevision: 2 } }));
    assert.equal(reset.revision, 3);
    assert.equal(reset.data.portfolio.assets.length, 0);
    ok(await request('/auth/v1/logout', { method: 'POST', token: sessionA.access_token }));
    assert.equal((await request('/auth/v1/user', { token: sessionA.access_token })).response.status, 401);
    const deleted = ok(await request('/functions/v1/account-tools', { method: 'POST', token: sessionB.access_token, body: { action: 'delete-account', confirmed: true, phrase: 'LÖSCHEN', password: 'noch-sichereres-passwort' } }));
    assert.equal(deleted.deleted, true);
    assert.equal((await request('/auth/v1/user', { token: sessionB.access_token })).response.status, 401);
  });
});
