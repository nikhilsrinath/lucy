/**
 * Document library · the reader.
 *
 *   POST /api/library  { action: 'process', org_id, document_id }
 *
 * The browser uploads the file to the private `library` bucket and inserts its
 * row under RLS; this endpoint then reads it. It runs server-side because the
 * parsers are heavy, the AI key must not reach the browser, and the passages
 * the AI later retrieves (library_chunks) are writable by the service role
 * only — so what the assistant quotes is always what the file said, never
 * something a client posted.
 *
 * Deterministic parsing for anything with text in it; the AI only for images
 * and scanned PDFs, metered against the same AI message counter as a chat.
 */
import { requireUser, requireOrgRole, HttpError, sendError, methodIs, readJsonBody } from './_lib/auth.js';
import { supabaseAdmin } from './_lib/supabaseAdmin.js';
import { logAiUsage } from './_lib/aiUsage.js';
import { allowedResources } from './_lib/brainRetrieval.js';
import { extractDocument, chunkMarkdown, leadSummary } from './_lib/libraryExtract.js';
import { AI_URL, AI_MODEL, aiKey, aiHeaders, reasoningEffort } from './_lib/aiProvider.js';

export const config = { maxDuration: 60 };

const BUCKET = 'library';
const MODEL = AI_MODEL;
// Inline data is capped upstream at ~20 MB per request, base64 included.
const OCR_MAX_BYTES = 14 * 1024 * 1024;
// Mirrors api/nvidia.js and api/brain.js.
const AI_MESSAGE_LIMITS = { free: 10, pro: 50, max: Infinity };

export default async function handler(req, res) {
  if (!methodIs(req, res, 'POST')) return undefined;
  try {
    const body = await readJsonBody(req);
    const { action, org_id: orgId, document_id: docId } = body || {};
    if (action !== 'process') throw new HttpError(400, `Unknown action: ${action || '(none)'}`);
    if (!docId) throw new HttpError(400, 'Missing document_id');

    const user = await requireUser(req);
    await requireOrgRole(user.id, orgId, 'viewer');
    const { perms } = await allowedResources(orgId, user.id);
    const p = perms?.library_documents;
    if (!p?.create && !p?.edit) throw new HttpError(403, 'Your role cannot add documents to the library');

    return res.status(200).json(await processDocument(orgId, docId, user));
  } catch (err) {
    return sendError(res, err, 'library');
  }
}

async function processDocument(orgId, docId, user) {
  const db = supabaseAdmin();
  const { data: doc, error } = await db.from('library_documents')
    .select('id, org_id, title, file_name, mime_type, size_bytes, storage_path')
    .eq('id', docId).eq('org_id', orgId).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!doc) throw new HttpError(404, 'Document not found');

  await db.from('library_documents')
    .update({ extraction_status: 'processing', extraction_error: null }).eq('id', doc.id);

  let outcome;
  try {
    const { data: blob, error: dlErr } = await db.storage.from(BUCKET).download(doc.storage_path);
    if (dlErr || !blob) throw new Error(`The stored file could not be read: ${dlErr?.message || 'missing'}`);
    const buffer = await blob.arrayBuffer();

    outcome = await extractDocument(
      { buffer, fileName: doc.file_name, mimeType: doc.mime_type, title: doc.title },
      { ocr: aiKey() ? (bytes, mime, hint) => ocr(orgId, bytes, mime, hint, user) : null },
    );
  } catch (err) {
    outcome = { status: 'failed', method: null, markdown: '', pages: null, error: err?.message || String(err) };
  }

  // Passages are replaced wholesale: a re-read must not leave the previous
  // version's text behind to be quoted.
  await db.from('library_chunks').delete().eq('document_id', doc.id);
  const chunks = outcome.markdown ? chunkMarkdown(outcome.markdown) : [];
  for (let i = 0; i < chunks.length; i += 200) {
    const { error: cErr } = await db.from('library_chunks').insert(
      chunks.slice(i, i + 200).map((c) => ({ org_id: orgId, document_id: doc.id, ...c })),
    );
    if (cErr) {
      outcome = { ...outcome, status: 'failed', error: `Passages could not be saved: ${cErr.message}` };
      await db.from('library_chunks').delete().eq('document_id', doc.id);
      chunks.length = 0;
      break;
    }
  }

  const patch = {
    extraction_status: outcome.status,
    extraction_method: outcome.method,
    extraction_error: outcome.error,
    content_md: outcome.markdown || null,
    summary: leadSummary(outcome.markdown),
    page_count: outcome.pages,
    char_count: outcome.markdown ? outcome.markdown.length : 0,
    chunk_count: chunks.length,
    extracted_at: new Date().toISOString(),
  };
  const { error: upErr } = await db.from('library_documents').update(patch).eq('id', doc.id);
  if (upErr) throw new HttpError(500, upErr.message);

  return {
    success: true,
    document_id: doc.id,
    status: patch.extraction_status,
    method: patch.extraction_method,
    error: patch.extraction_error,
    pages: patch.page_count,
    passages: patch.chunk_count,
    characters: patch.char_count,
  };
}

/* ── AI reading, for files with no text to parse ──────────────────────────── */

async function ocr(orgId, bytes, mimeType, hint, user) {
  if (bytes.byteLength > OCR_MAX_BYTES) {
    throw new Error(`Files over ${OCR_MAX_BYTES / 1048576} MB cannot be read by AI; upload a smaller scan or a PDF with a text layer.`);
  }

  // The default model (Qwen 3.7 Flash) reads images but not PDFs. Say so before
  // metering, rather than spend a message on a request that cannot succeed.
  if (mimeType === 'application/pdf' && !MODEL.startsWith('google/')) {
    throw new Error('Scanned PDFs cannot be read by the current AI model. Upload the pages as images, or a PDF with a text layer.');
  }

  // Metered before the call, as every other AI path is.
  const { data: used, error: meterErr } = await supabaseAdmin().rpc('bump_ai_usage', { p_org: orgId });
  if (meterErr) console.warn('[library] AI usage not counted:', meterErr.message);
  const { data: sub } = await supabaseAdmin()
    .from('subscriptions').select('plan').eq('org_id', orgId).maybeSingle();
  const limit = AI_MESSAGE_LIMITS[sub?.plan || 'free'] ?? AI_MESSAGE_LIMITS.free;
  if (Number(used) > limit) {
    await logAiUsage({ orgId, user, surface: 'library', outcome: 'blocked' });
    throw new Error('Your plan\'s AI message limit is reached, so this file could not be read. Text documents are unaffected.');
  }

  const prompt =
    `You are converting ${hint} into Markdown so it can be searched and quoted later.\n` +
    'Rules:\n' +
    '- Transcribe every piece of text exactly as written. Do not summarise, correct or translate it.\n' +
    '- Keep structure: headings as ##, lists as -, tables as Markdown tables.\n' +
    '- For charts, give the title, axes and the values you can read. For photos or diagrams, one short factual description.\n' +
    '- If something is illegible write [illegible]. Never guess a number or a name.\n' +
    '- Output only the Markdown, with no preamble and no code fences around it.';

  // The file travels inline as a data URL: a PDF as a `file` part (the model
  // reads it natively, pages and all), an image as an `image_url` part.
  const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
  const filePart = mimeType === 'application/pdf'
    ? { type: 'file', file: { filename: 'document.pdf', file_data: dataUrl } }
    : { type: 'image_url', image_url: { url: dataUrl } };

  const response = await fetch(AI_URL, {
    method: 'POST',
    headers: aiHeaders(aiKey()),
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, filePart] }],
      temperature: 0,
      max_tokens: 16384,
      // Transcription gains nothing from thinking, and every thinking token
      // is billed as output.
      reasoning_effort: reasoningEffort('none'),
      stream: false,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('[library] AI provider error', response.status, detail.slice(0, 400));
    await logAiUsage({ orgId, user, surface: 'library', outcome: 'failed', model: MODEL });
    throw new Error(`AI reading failed (${response.status}).`);
  }
  const json = await response.json();
  await logAiUsage({
    orgId, user, surface: 'library', model: MODEL,
    promptTokens: json?.usage?.prompt_tokens,
    completionTokens: json?.usage?.completion_tokens,
  });
  const text = String(json?.choices?.[0]?.message?.content || '').trim()
    .replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, '$1');
  if (!text) throw new Error('The AI returned no text for this file.');
  return text;
}
