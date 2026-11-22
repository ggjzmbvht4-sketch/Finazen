import { getDocumentProxy, extractText } from 'unpdf';
import { userFromRequest } from './auth';
import { all, decodeRow, first, json, now, run, uuid } from './db';
import { rpc } from './rpc';
import {
  ANALYSIS_SCHEMA, LIMITS, SYSTEM_PROMPT, assetBasis, basisHash, computeValuation,
  inspectDocument, isDate, validateAnalysis,
} from './report-core';

class ReportError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function safeMessage(value: unknown, secret = '') {
  let text = String(value || 'Berichtsdienst nicht verfügbar.').replace(/Bearer\s+\S+/gi, 'Bearer [entfernt]').replace(/[\r\n]+/g, ' ').slice(0, 500);
  if (secret.length > 3) text = text.split(secret).join('[entfernt]');
  return text;
}

function modelId(env: any) {
  return String(env.OPENROUTER_REPORT_MODEL || env.OPENROUTER_MODEL || 'anthropic/claude-haiku-5.5').trim();
}

function analysisRow(row: any) {
  return decodeRow('report_analyses', row);
}

async function loadPlan(env: any, owner: string, revision?: unknown) {
  const row: any = await first(env, 'SELECT data,revision FROM finance_plans WHERE owner_id=?', [owner]);
  if (!row) throw new ReportError('Bitte zuerst den Finanzplan synchronisieren.', 409);
  if (revision !== undefined && Number(row.revision) !== Number(revision)) throw new ReportError('SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.', 409);
  return { data: JSON.parse(row.data), revision: Number(row.revision) };
}

async function extractPdf(bytes: Uint8Array) {
  try {
    const pdf = await getDocumentProxy(bytes);
    const extracted: any = await extractText(pdf, { mergePages: false });
    const pages: string[] = Array.isArray(extracted.text) ? extracted.text : [String(extracted.text || '')];
    const text = pages.map((page, index) => `\n\n[Seite ${index + 1}]\n${page}`).join('').trim();
    if (!text) throw new ReportError('Das PDF enthält keinen extrahierbaren Text. Bitte eine durchsuchbare PDF oder Textdatei verwenden.');
    if (text.length > 500000) throw new ReportError('Der extrahierte PDF-Text ist zu lang. Bitte den relevanten Berichtsteil als separate Datei hochladen.');
    return text;
  } catch (error: any) {
    if (error instanceof ReportError) throw error;
    throw new ReportError('Das PDF konnte nicht gelesen werden. Bitte eine unverschlüsselte, durchsuchbare PDF verwenden.');
  }
}

async function callRpc(env: any, name: string, payload: any) {
  const response = await rpc(env, name, payload);
  const data: any = await response.json();
  if (!response.ok) throw new ReportError(data?.message || 'Kostenbudget konnte nicht geprüft werden.', response.status);
  return data;
}

async function openRouterAnalysis(env: any, owner: string, basis: any, documents: any[]) {
  const key = String(env.OPENROUTER_API_KEY || ''), model = modelId(env);
  if (!key || !model) throw new ReportError('OpenRouter-Schlüssel oder Berichtsmodell ist noch nicht eingerichtet.', 503);
  if (env.TRADING212_OWNER_ID && env.TRADING212_OWNER_ID !== owner) throw new ReportError('Dieser API-Zugang ist für ein anderes persönliches Konto freigegeben.', 403);
  const haiku = /^anthropic\/claude-haiku-5[.-]5(?:-|$)/.test(model);
  const price = haiku ? { prompt: 0.1, completion: 0.5 } : model === 'openai/gpt-4.1-mini' ? { prompt: 0.4, completion: 1.6 } : { prompt: 1, completion: 5 };
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ investorBasis: basis, documents: documents.map((doc) => ({ documentId: doc.id, name: doc.name, category: doc.category, reportDate: doc.reportDate, text: doc.text })) }) },
  ];
  const inputBytes = new TextEncoder().encode(JSON.stringify(messages)).length;
  if (inputBytes > 24 * 1024 * 1024) throw new ReportError('Die KI-Eingabe ist zu groß. Bitte weniger oder kürzere Dokumente auswählen.', 413);
  const maxTokens = 6000, ticketId = uuid();
  const reservedMicros = Math.max(1, Math.ceil((inputBytes * price.prompt + maxTokens * price.completion) * 2));
  await callRpc(env, 'reserve_v12_cost', { p_owner: owner, p_id: ticketId, p_bucket: 'ai', p_micros: reservedMicros, p_meta: { model, kind: 'investment-report' } });
  let response: Response | undefined, output: any, settled = false;
  const settle = async (state: 'settled'|'released'|'uncertain', micros: number|null = null) => {
    if (settled) return;
    settled = true;
    await callRpc(env, 'settle_v12_cost', { p_owner: owner, p_id: ticketId, p_state: state, p_micros: micros, p_response_id: response?.headers.get('x-request-id') || output?.id || null });
  };
  try {
    const request: any = {
      model, messages, max_tokens: maxTokens, usage: { include: true },
      response_format: { type: 'json_schema', json_schema: { name: 'investment_report_analysis', strict: true, schema: ANALYSIS_SCHEMA } },
      provider: { data_collection: 'deny', require_parameters: true, max_price: price },
    };
    if (haiku) request.reasoning = { effort: 'low' };
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(110000),
    });
    try { output = await response.json(); } catch { output = null; }
    if (!response.ok || output?.error) {
      const status = Number(output?.error?.code) || response.status;
      const permanent = [400,401,402,403,404,422].includes(status);
      await settle(permanent && !output?.id ? 'released' : 'uncertain');
      const detail = safeMessage(output?.error?.message || '', key);
      throw new ReportError(`OpenRouter: Anfrage abgelehnt (${status}) · Modell ${model}${detail ? ': ' + detail : ''}`, status >= 400 && status < 500 ? status : 502);
    }
    const usd = Number(output?.usage?.cost);
    await settle(Number.isFinite(usd) && usd >= 0 ? 'settled' : 'uncertain', Number.isFinite(usd) && usd >= 0 ? Math.ceil(usd * 2 * 1e6) : null);
    const content = output?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: any) => part?.text || '').join('') : '';
    if (!text) throw new ReportError('Die KI hat kein Ergebnis geliefert.', 502);
    try { return JSON.parse(text); } catch { throw new ReportError('Die KI hat kein gültiges JSON-Ergebnis geliefert.', 502); }
  } catch (error: any) {
    await settle('uncertain').catch(() => {});
    if (error instanceof ReportError) throw error;
    throw new ReportError('OpenRouter ist nicht erreichbar oder die Anfrage wurde unterbrochen.', 502);
  }
}

async function listReports(env: any, owner: string) {
  const [documents, analyses] = await Promise.all([
    all(env, 'SELECT id,owner_id,asset_id,asset_name,name,mime_type,size_bytes,sha256,report_date,category,status,created_at FROM report_documents WHERE owner_id=? ORDER BY created_at DESC LIMIT 500', [owner]),
    all(env, 'SELECT * FROM report_analyses WHERE owner_id=? ORDER BY created_at DESC LIMIT 200', [owner]),
  ]);
  return json({
    documents,
    analyses: analyses.map(analysisRow),
    configuration: { aiReady: Boolean(env.OPENROUTER_API_KEY && modelId(env)), model: modelId(env), pdfEngine: 'native', storageLimitBytes: LIMITS.storageBytes },
  });
}

async function upload(env: any, owner: string, request: Request) {
  const form = await request.formData(), file = form.get('file');
  if (!(file instanceof File)) throw new ReportError('Bitte eine Datei auswählen.');
  const assetId = String(form.get('assetId') || ''), reportDate = String(form.get('reportDate') || ''), category = String(form.get('category') || 'report');
  if (!/^[\w-]{1,80}$/.test(assetId) || !['report','financial','contract','other'].includes(category)) throw new ReportError('Investment oder Dokumentkategorie ist ungültig.');
  if (reportDate && !isDate(reportDate)) throw new ReportError('Berichtsdatum ist ungültig.');
  const plan = await loadPlan(env, owner), basis = assetBasis(plan.data, assetId);
  const bytes = new Uint8Array(await file.arrayBuffer()), inspected = inspectDocument(file.name, file.type, bytes);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2,'0')).join('');
  const duplicate: any = await first(env, 'SELECT id,owner_id,asset_id,asset_name,name,mime_type,size_bytes,sha256,report_date,category,status,created_at FROM report_documents WHERE owner_id=? AND asset_id=? AND sha256=?', [owner, assetId, hash]);
  if (duplicate) return json({ document: duplicate });
  const usage: any = await first(env, 'SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM report_documents WHERE owner_id=?', [owner]);
  if (Number(usage?.bytes || 0) + bytes.length > LIMITS.storageBytes) throw new ReportError('Der private Berichtsspeicher von 50 MB ist voll. Bitte zuerst nicht mehr benötigte Originale entfernen.', 409);
  const text = inspected.extension === 'pdf' ? await extractPdf(bytes) : inspected.text;
  const id = uuid(), key = `${owner}/${id}.${inspected.extension}`;
  await env.REPORTS.put(key, bytes, { httpMetadata: { contentType: inspected.mime }, customMetadata: { owner, assetId, sha256: hash } });
  try {
    await run(env, `INSERT INTO report_documents(id,owner_id,asset_id,asset_name,name,mime_type,size_bytes,sha256,report_date,category,status,storage_key,extracted_text,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'ready',?,?,?)`, [id, owner, assetId, basis.name, String(file.name).slice(0,240), inspected.mime, bytes.length, hash, reportDate || null, category, key, text, now()]);
  } catch (error) {
    await env.REPORTS.delete(key).catch(() => {});
    throw error;
  }
  const document = await first(env, 'SELECT id,owner_id,asset_id,asset_name,name,mime_type,size_bytes,sha256,report_date,category,status,created_at FROM report_documents WHERE id=?', [id]);
  return json({ document }, 201);
}

async function analyse(env: any, owner: string, data: any) {
  const requestId = String(data.requestId || '');
  if (!/^[\w-]{1,100}$/.test(requestId) || !Array.isArray(data.documentIds)) throw new ReportError('Analyseanfrage ist ungültig.');
  const existing: any = await first(env, 'SELECT * FROM report_analyses WHERE owner_id=? AND request_id=?', [owner, requestId]);
  if (existing) return json({ analysis: analysisRow(existing) });
  const ids: string[] = [...new Set<string>(data.documentIds.map((value: unknown) => String(value)))];
  if (ids.length < 1 || ids.length > LIMITS.documents || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new ReportError('Bitte 1–4 gültige Dokumente auswählen.');
  const plan = await loadPlan(env, owner, data.planRevision), basis = assetBasis(plan.data, String(data.assetId || ''));
  const placeholders = ids.map(() => '?').join(',');
  const rows: any[] = await all(env, `SELECT * FROM report_documents WHERE owner_id=? AND asset_id=? AND status='ready' AND id IN (${placeholders})`, [owner, data.assetId, ...ids]);
  if (rows.length !== ids.length || rows.some((row) => !row.extracted_text)) throw new ReportError('Ein Dokument fehlt oder ist noch nicht analysierbar.');
  if (rows.reduce((sum, row) => sum + Number(row.size_bytes), 0) > LIMITS.totalBytes) throw new ReportError('Die Auswahl überschreitet 16 MB.');
  const documents = ids.map((id) => rows.find((row) => row.id === id)).map((row) => ({ id: row.id, name: row.name, text: row.extracted_text, category: row.category, reportDate: row.report_date || '' }));
  const id = uuid(), model = modelId(env), hash = await basisHash(basis), stamp = now();
  await run(env, `INSERT INTO report_analyses(id,owner_id,request_id,asset_id,asset_name,basis_hash,status,basis,model,document_ids,created_at)
    VALUES(?,?,?,?,?,?,'running',?,?,?,?)`, [id, owner, requestId, data.assetId, basis.name, hash, basis, model, ids, stamp]);
  try {
    const raw = await openRouterAnalysis(env, owner, basis, documents);
    const analysis = validateAnalysis(raw, documents), valuation = computeValuation(analysis, basis, documents);
    await run(env, "UPDATE report_analyses SET status='completed',result=?,finished_at=? WHERE id=? AND owner_id=?", [{ analysis, valuation }, now(), id, owner]);
  } catch (error: any) {
    await run(env, "UPDATE report_analyses SET status='failed',error=?,finished_at=? WHERE id=? AND owner_id=?", [safeMessage(error?.message, env.OPENROUTER_API_KEY || ''), now(), id, owner]);
  }
  const analysis = await first(env, 'SELECT * FROM report_analyses WHERE id=? AND owner_id=?', [id, owner]);
  return json({ analysis: analysisRow(analysis) });
}

async function download(env: any, owner: string, data: any) {
  const document: any = await first(env, 'SELECT * FROM report_documents WHERE id=? AND owner_id=?', [String(data.documentId || ''), owner]);
  if (!document) throw new ReportError('Dokument nicht gefunden.', 404);
  const object = await env.REPORTS.get(document.storage_key);
  if (!object) throw new ReportError('Die Originaldatei ist nicht verfügbar.', 404);
  const fallback = document.name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return new Response(object.body, { headers: {
    'Content-Type': document.mime_type, 'Content-Length': String(document.size_bytes),
    'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(document.name)}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}

async function deleteDocument(env: any, owner: string, data: any) {
  const document: any = await first(env, 'SELECT * FROM report_documents WHERE id=? AND owner_id=?', [String(data.documentId || ''), owner]);
  if (!document) throw new ReportError('Dokument nicht gefunden.', 404);
  await env.REPORTS.delete(document.storage_key);
  await run(env, 'DELETE FROM report_documents WHERE id=? AND owner_id=?', [document.id, owner]);
  return json({ deleted: true });
}

async function adopt(env: any, owner: string, data: any) {
  if (data.reviewed !== true) throw new ReportError('Bitte die Quellen- und Annahmenprüfung bestätigen.');
  const analysis: any = analysisRow(await first(env, 'SELECT * FROM report_analyses WHERE id=? AND owner_id=?', [String(data.analysisId || ''), owner]));
  const valuation = analysis?.result?.valuation;
  if (!analysis || analysis.status !== 'completed' || valuation?.status !== 'assessed') throw new ReportError('Keine übernehmbare Bewertung gefunden.');
  if (analysis.adopted_at) throw new ReportError('Diese Bewertung wurde bereits übernommen.', 409);
  const plan = await loadPlan(env, owner, data.planRevision), next = structuredClone(plan.data);
  const asset = next.portfolio?.assets?.find((item: any) => item.id === analysis.asset_id);
  if (!asset || asset.valuationMode !== 'manual') throw new ReportError('Das Investment benötigt einen manuellen Wertstand.');
  const currentHash = await basisHash(assetBasis(next, asset.id));
  if (currentHash !== analysis.basis_hash) throw new ReportError('Die Beteiligungsbedingungen wurden seit der Analyse geändert. Bitte erneut analysieren.', 409);
  const stamp = now(), revision = plan.revision + 1, quoteId = uuid();
  next.portfolio.quotes.push({ id: quoteId, assetId: asset.id, instrumentId: '', value: valuation.baseCents, priceMicros: 0, fxMicros: 1000000, asOf: valuation.asOf, source: 'estimate', note: `KI-Berichtsanalyse ${analysis.id}; Quellen und Annahmen geprüft.`, createdAt: stamp });
  next.updatedAt = stamp;
  const outcomes: any = await env.DB.batch([
    env.DB.prepare('UPDATE finance_plans SET data=?,revision=?,updated_at=? WHERE owner_id=? AND revision=?').bind(JSON.stringify(next), revision, stamp, owner, plan.revision),
    env.DB.prepare(`UPDATE report_analyses SET adopted_at=? WHERE id=? AND owner_id=? AND adopted_at IS NULL AND EXISTS(
      SELECT 1 FROM finance_plans fp, json_each(json_extract(fp.data,'$.portfolio.quotes')) quote
      WHERE fp.owner_id=? AND fp.revision=? AND json_extract(quote.value,'$.id')=?
    )`).bind(stamp, analysis.id, owner, owner, revision, quoteId),
  ]);
  if (!Number(outcomes[0]?.meta?.changes || 0)) throw new ReportError('SYNC_CONFLICT: Der Cloud-Stand wurde auf einem anderen Gerät geändert.', 409);
  if (!Number(outcomes[1]?.meta?.changes || 0)) throw new ReportError('Diese Bewertung wurde bereits übernommen.', 409);
  return json({ data: next, revision });
}

export function createReportsHandler(env: any) {
  return async (request: Request) => {
    if (request.method !== 'POST') return json({ error: 'Nur POST' }, 405);
    try {
      const user = await userFromRequest(env, request);
      if (!user) throw new ReportError('Bitte erneut anmelden.', 401);
      if (!env.REPORTS) throw new ReportError('R2-Berichtsspeicher ist nicht konfiguriert.', 503);
      if (request.headers.get('Content-Type')?.includes('multipart/form-data')) return await upload(env, user.id, request);
      let data: any;
      try { data = await request.json(); } catch { throw new ReportError('Ungültige Anfrage.'); }
      if (data.action === 'list') return listReports(env, user.id);
      if (data.action === 'analyse') return analyse(env, user.id, data);
      if (data.action === 'download') return download(env, user.id, data);
      if (data.action === 'delete-document') return deleteDocument(env, user.id, data);
      if (data.action === 'adopt') return adopt(env, user.id, data);
      throw new ReportError('Unbekannte Aktion.');
    } catch (error: any) {
      return json({ error: safeMessage(error?.message, env.OPENROUTER_API_KEY || '') }, error instanceof ReportError ? error.status : 400);
    }
  };
}
