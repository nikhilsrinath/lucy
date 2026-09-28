// libraryService.js — the general document library (0063).
//
// Files live in the private 'library' bucket at '<org_id>/<uuid>.<ext>'; the
// row stores the path, never a URL. After an upload, /api/library reads the
// file into Markdown and passages, which is what EdgeBrain and the copilot
// quote. Reads here run under RLS (resource `library_documents`).
//
// The list never selects content_md: a library of long PDFs would otherwise
// pull every word of every file into the browser to draw a table.
import { supabase } from '../lib/supabase';

export const LIBRARY_BUCKET = 'library';
export const LIBRARY_MAX_BYTES = 25 * 1024 * 1024;

export const CATEGORIES = [
  { id: 'general',   label: 'General' },
  { id: 'policy',    label: 'Policies' },
  { id: 'contract',  label: 'Contracts' },
  { id: 'finance',   label: 'Finance' },
  { id: 'hr',        label: 'HR' },
  { id: 'sales',     label: 'Sales' },
  { id: 'product',   label: 'Product' },
  { id: 'reference', label: 'Reference' },
];
export const categoryLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label || id;

/** What the reader can and cannot do with a file, for the upload hint. */
export const READABLE_HINT =
  'PDF, Word, PowerPoint, Excel/CSV, OpenDocument, text, Markdown, HTML and images can be read by your cofounder. ' +
  'Anything else is stored but not searchable.';

const LIST_COLUMNS =
  'id, title, description, category, tags, file_name, mime_type, size_bytes, storage_path, ' +
  'extraction_status, extraction_method, extraction_error, summary, page_count, char_count, ' +
  'chunk_count, extracted_at, created_by, created_at, updated_at';

export function validateLibraryFile(file) {
  if (!file) return 'No file selected.';
  if (!file.size) return `${file.name} is empty.`;
  if (file.size > LIBRARY_MAX_BYTES) {
    return `${file.name} is ${(file.size / 1048576).toFixed(1)} MB; the limit is 25 MB.`;
  }
  return null;
}

/** "Q3 board deck.final.pptx" → "Q3 board deck.final". */
export function titleFromFileName(name) {
  return String(name || 'Untitled').replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 200) || 'Untitled';
}

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : 'bin';
}

async function authHeader() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not signed in');
  return { Authorization: `Bearer ${session.access_token}` };
}

export const libraryService = {
  async list(orgId) {
    if (!orgId) return [];
    const { data, error } = await supabase.from('library_documents')
      .select(LIST_COLUMNS).eq('org_id', orgId).order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  /** One document, with its full Markdown. */
  async get(id) {
    const { data, error } = await supabase.from('library_documents')
      .select(`${LIST_COLUMNS}, content_md`).eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  },

  /**
   * Stores the file, creates its row, then asks the server to read it.
   * Resolves with the row once reading has finished (or failed — a file that
   * could not be read is still stored, and says why).
   */
  async upload(orgId, file, meta = {}) {
    const problem = validateLibraryFile(file);
    if (problem) throw new Error(problem);
    if (!orgId) throw new Error('No organization selected.');

    const path = `${orgId}/${crypto.randomUUID()}.${extOf(file.name)}`;
    const { error: upErr } = await supabase.storage.from(LIBRARY_BUCKET).upload(path, file, {
      contentType: file.type || 'application/octet-stream', upsert: false,
    });
    if (upErr) throw upErr;

    const { data: row, error } = await supabase.from('library_documents').insert({
      org_id: orgId,
      title: (meta.title || titleFromFileName(file.name)).slice(0, 200),
      description: meta.description || null,
      category: meta.category || 'general',
      tags: meta.tags || [],
      file_name: file.name.slice(0, 255),
      mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
      storage_path: path,
    }).select(LIST_COLUMNS).single();
    if (error) {
      // No row, so nothing points at the object: take it back out.
      await supabase.storage.from(LIBRARY_BUCKET).remove([path]);
      throw error;
    }

    try {
      await libraryService.process(orgId, row.id);
    } catch (e) {
      console.warn('[libraryService] reading failed:', e.message);
    }
    return (await libraryService.get(row.id)) || row;
  },

  /** (Re-)reads a stored file into Markdown and passages. */
  async process(orgId, id) {
    const res = await fetch('/api/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ action: 'process', org_id: orgId, document_id: id }),
    });
    let json = null;
    try { json = await res.json(); } catch { /* status text below */ }
    if (!res.ok || json?.success === false) throw new Error(json?.error || `Reading failed (${res.status})`);
    return json;
  },

  async update(id, patch) {
    const allowed = {};
    for (const k of ['title', 'description', 'category', 'tags']) if (k in patch) allowed[k] = patch[k];
    const { data, error } = await supabase.from('library_documents')
      .update(allowed).eq('id', id).select(LIST_COLUMNS).single();
    if (error) throw error;
    return data;
  },

  /** Row first: once it is gone nothing references the object, so a failed object delete only costs storage. */
  async remove(doc) {
    const { error } = await supabase.from('library_documents').delete().eq('id', doc.id);
    if (error) throw error;
    const { error: sErr } = await supabase.storage.from(LIBRARY_BUCKET).remove([doc.storage_path]);
    if (sErr) console.warn('[libraryService] object remove failed:', sErr.message);
  },

  /** Opens the original in a new tab through a five-minute signed link. */
  async open(doc, { download = false } = {}) {
    const { data, error } = await supabase.storage.from(LIBRARY_BUCKET)
      .createSignedUrl(doc.storage_path, 300, download ? { download: doc.file_name } : undefined);
    if (error || !data?.signedUrl) throw new Error(error?.message || 'The file could not be opened.');
    window.open(data.signedUrl, '_blank', 'noopener');
  },

  /** Saves the extracted Markdown as a .md file. */
  downloadMarkdown(doc) {
    if (!doc?.content_md) return;
    const blob = new Blob([doc.content_md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${titleFromFileName(doc.file_name)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  /**
   * Full-text search inside every readable document. Returns
   * Map<document_id, { heading, snippet }> for the best passage of each.
   */
  async searchInside(orgId, text) {
    const q = String(text || '').trim();
    if (!orgId || q.length < 2) return new Map();
    const { data, error } = await supabase.from('library_chunks')
      .select('document_id, heading, content')
      .eq('org_id', orgId)
      .textSearch('search_text', q, { config: 'simple', type: 'websearch' })
      .limit(200);
    if (error) throw error;
    const out = new Map();
    const needle = q.toLowerCase().split(/\s+/)[0];
    for (const c of data || []) {
      if (out.has(c.document_id)) continue;
      const at = Math.max(0, c.content.toLowerCase().indexOf(needle) - 60);
      out.set(c.document_id, {
        heading: c.heading,
        snippet: (at > 0 ? '…' : '') + c.content.slice(at, at + 180).replace(/\s+/g, ' ') + '…',
      });
    }
    return out;
  },
};

export default libraryService;
