// ParentFirst — report intelligence.
//
//   1. READ     a vision model reads every row of the report as a person would
//               (lab PDFs interleave columns, so text parsing alone is unreliable)
//   2. VERIFY   every number it reports is checked against the numbers actually
//               present in the document's own text layer — a hallucinated value
//               won't be there
//   3. RE-READ  values that fail the check get an independent second read by the
//               strongest model, which confirms, corrects, or removes them
//   4. ANALYSE  grouped by body system, every printed range, how far off, trend
//               vs the previous report, and a careful narrative (never a diagnosis)
//
// Every model call goes through an injectable `call`, so the pipeline is testable.
import { PDFParse } from 'pdf-parse';
import { callModel, callJSON } from './ai.js';

export const CATEGORIES = ['Blood counts', 'Sugar', 'Lipids', 'Kidney', 'Liver', 'Thyroid', 'Vitamins',
  'Electrolytes', 'Iron', 'Urine', 'Cardiac', 'Inflammation', 'Hormones', 'Other'];

export const EXTRACT_PROMPT = `You are reading an Indian medical laboratory report. Transcribe it into JSON — ONLY JSON, no prose.

{"type":"short report title, e.g. Complete Health Checkup","lab":"lab name","doctor":"referring doctor or empty","date":"YYYY-MM-DD (sample collection date)",
 "patient_name":"as printed","patient_age":"as printed, e.g. 54 Years","patient_sex":"M or F or empty",
 "params":[{"name":"test name exactly as printed","category":"${CATEGORIES.join(' | ')}","value":number,"unit":"unit as printed","ref_low":number or null,"ref_high":number or null,"ref_text":"reference interval exactly as printed","flag":"H or L or empty — only if the report itself marks it"}],
 "qualitative":[{"name":"test name","result":"text result as printed, e.g. Nil, Absent, Pale yellow","ref_text":"normal as printed or empty","category":"one of the categories above"}]}

RULES
- Capture EVERY result row on EVERY page. A CBC alone has 15-25 rows (RBC, WBC, each differential % and absolute count, MCV, MCH, MCHC, RDW, platelets, MPV...). Never summarise, skip, or merge rows. If there are 60 results, return 60.
- The RESULT is the patient's value. Do not confuse it with the reference interval, the method name, or the unit.
- Numeric results go in "params" (value must be a number). Text results (Nil, Absent, Positive, colour) go in "qualitative".
- Reference intervals: "136 - 145" → ref_low 136, ref_high 145. "< 200" → ref_low null, ref_high 200. "> 40" → ref_low 40, ref_high null. Always copy the printed text into ref_text.
- Ignore watermarks, barcodes, page headers/footers, sample IDs, and interpretive paragraphs.`;

const RECHECK_PROMPT = (items) => `Another reader extracted the values below from this lab report, but they could not be matched to the document's text.
Look at the report carefully and check each one against what is actually printed.

${items.map((p, i) => `${i + 1}. ${p.name}: ${p.value} ${p.unit || ''}`).join('\n')}

Return ONLY JSON: {"checks":[{"name":"exactly as listed","present":true or false,"printed_value":number or null}]}
- present=false if this test does not appear in the report at all.
- printed_value = the patient's result exactly as printed (not the reference interval).`;

// ── the document's own text, minus watermarks/headers that repeat on every page ──
export async function textLayer(buf) {
  let parser = null;
  try {
    parser = new PDFParse({ data: buf });
    const r = await parser.getText();
    const lines = String(r.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const freq = new Map();
    for (const l of lines) freq.set(l, (freq.get(l) || 0) + 1);
    const text = lines.filter((l) => freq.get(l) < 6).join('\n');
    return text.replace(/\s+/g, '').length >= 200 ? text : null;   // < 200 chars → a scanned image, no usable text
  } catch { return null; }
  finally { try { await parser?.destroy?.(); } catch { /* ignore */ } }
}

export function numbersIn(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) set.add(String(n));
  }
  return set;
}

// coerce what the model returned into clean rows
export function sanitizeParams(raw) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(raw) ? raw : []) {
    const name = String(p?.name || '').trim();
    const value = typeof p?.value === 'number' ? p.value : Number(String(p?.value ?? '').replace(/,/g, '').trim());
    if (!name || !Number.isFinite(value)) continue;
    const key = name.toLowerCase() + '|' + value;
    if (seen.has(key)) continue;               // the same row read twice
    seen.add(key);
    const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
    out.push({
      name, value, unit: p.unit ? String(p.unit).trim() : null,
      category: CATEGORIES.includes(p.category) ? p.category : 'Other',
      ref_low: num(p.ref_low), ref_high: num(p.ref_high), ref_text: p.ref_text ? String(p.ref_text).trim() : null,
      flag: /^h/i.test(String(p.flag || '')) ? 'H' : /^l/i.test(String(p.flag || '')) ? 'L' : null,
    });
  }
  return out;
}

export function verifyAgainstText(params, text) {
  if (!text) return params.map((p) => ({ ...p, verified: 'unchecked' }));
  const nums = numbersIn(text);
  return params.map((p) => ({ ...p, verified: nums.has(String(Number(p.value))) ? 'document' : 'unverified' }));
}

export function docBlock(buf, mime) {
  const data = buf.toString('base64');
  return mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data } };
}

/**
 * Read → verify → re-read. Returns { obj, stats }.
 * obj.params carry `verified`: 'document' | 'model' | 'corrected' | 'unverified' | 'unchecked'
 */
export async function runExtraction({ buf, mime, call = callModel }) {
  const doc = docBlock(buf, mime);
  const obj = await callJSON({ tier: 'extract', content: [doc, { type: 'text', text: EXTRACT_PROMPT }], maxTokens: 8000 }, call);
  const text = mime === 'application/pdf' ? await textLayer(buf) : null;
  let params = verifyAgainstText(sanitizeParams(obj.params), text);
  const stats = { total: 0, document: 0, model: 0, corrected: 0, removed: 0, unverified: 0, unchecked: 0, text_layer: !!text };

  const toCheck = params.filter((p) => p.verified !== 'document').slice(0, 60);
  if (toCheck.length) {
    try {
      const r = await callJSON({ tier: 'analyse', content: [doc, { type: 'text', text: RECHECK_PROMPT(toCheck) }], maxTokens: 4000 }, call);
      const checks = new Map((r.checks || []).map((c) => [String(c.name || '').toLowerCase(), c]));
      params = params.flatMap((p) => {
        if (p.verified === 'document') return [p];
        const c = checks.get(p.name.toLowerCase());
        if (!c) return [p];
        if (c.present === false) { stats.removed++; return []; }          // not in the report — drop it
        const printed = Number(c.printed_value);
        if (!Number.isFinite(printed)) return [p];
        if (printed === p.value) return [{ ...p, verified: 'model' }];
        return [{ ...p, value: printed, verified: 'corrected', first_read: p.value }];
      });
    } catch { /* second read failed: values stay marked unverified — never silently trusted */ }
  }
  for (const p of params) { stats[p.verified] = (stats[p.verified] || 0) + 1; }
  stats.total = params.length;
  const qualitative = (Array.isArray(obj.qualitative) ? obj.qualitative : [])
    .filter((q) => q && q.name && q.result)
    .map((q) => ({ name: String(q.name).trim(), result: String(q.result).trim(), ref_text: q.ref_text ? String(q.ref_text).trim() : null,
      category: CATEGORIES.includes(q.category) ? q.category : 'Other' }));
  return { obj: { ...obj, params, qualitative }, stats };
}

// ── analysis ──────────────────────────────────────────────────────────────
const isoDay = (v) => { if (!v) return null; const d = new Date(v); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

/**
 * Pure: grouped rows with status, deviation and trend. `rangeFor(p)` returns {min,max} or null.
 */
export function buildAnalysis(rep, params, previous, rangeFor) {
  const prev = {};
  for (const r of previous) if (!(r.name.toLowerCase() in prev)) prev[r.name.toLowerCase()] = r;
  const rows = params.map((p) => {
    const printed = p.ref_low != null || p.ref_high != null || !!p.ref_text;
    const r = printed ? { min: p.ref_low ?? -Infinity, max: p.ref_high ?? Infinity } : rangeFor(p);
    const lo = r && Number.isFinite(r.min) ? r.min : null;
    const hi = r && Number.isFinite(r.max) ? r.max : null;
    let status = 'no_range';
    if (p.lab_flag === 'H') status = 'high';
    else if (p.lab_flag === 'L') status = 'low';
    else if (lo !== null || hi !== null) status = (hi !== null && p.value > hi) ? 'high' : (lo !== null && p.value < lo) ? 'low' : 'ok';
    let deviation = null;
    if (status === 'high' && hi) deviation = Math.round(((p.value - hi) / Math.abs(hi)) * 100);
    if (status === 'low' && lo) deviation = Math.round(((lo - p.value) / Math.abs(lo)) * 100);
    const pv = prev[p.name.toLowerCase()];
    const trend = pv ? { previous: Number(pv.value), previous_date: isoDay(pv.report_date),
      change: Number((p.value - Number(pv.value)).toFixed(2)),
      direction: p.value > Number(pv.value) ? 'up' : p.value < Number(pv.value) ? 'down' : 'same' } : null;
    return { name: p.name, value: Number(p.value), unit: p.unit || null, category: p.category || 'Other',
      ref_low: lo, ref_high: hi, ref_text: p.ref_text || (lo !== null || hi !== null ? `${lo ?? ''}–${hi ?? ''}` : null),
      range_source: printed ? 'report' : (r ? 'standard' : 'none'),
      status, deviation_pct: deviation, lab_flag: p.lab_flag || null, verified: p.verified || 'unchecked', trend };
  });
  const groups = {};
  for (const row of rows) (groups[row.category] ||= []).push(row);
  const grouped = CATEGORIES.filter((k) => groups[k]).map((k) => ({
    category: k, params: groups[k], out_of_range: groups[k].filter((x) => x.status === 'high' || x.status === 'low').length }));
  const abnormal = rows.filter((x) => x.status === 'high' || x.status === 'low').sort((a, b) => (b.deviation_pct || 0) - (a.deviation_pct || 0));
  const verification = rows.reduce((acc, r) => { acc[r.verified] = (acc[r.verified] || 0) + 1; return acc; }, {});
  return {
    report: { id: rep.id, type: rep.report_type, date: isoDay(rep.report_date), lab: rep.lab_name, doctor: rep.doctor_name,
      patient_name: rep.patient_name || null, patient_age: rep.patient_age || null, patient_sex: rep.patient_sex || null },
    total: rows.length, abnormal_count: abnormal.length, grouped, abnormal, verification,
    qualitative: rep.qualitative || [],
  };
}

export const ANALYSE_PROMPT = (a) => `You are a careful health-literacy assistant reading ONE lab report for a family caregiver in India.
You are NOT a doctor. Never diagnose, never name a disease as fact, never suggest medicine changes.

Patient: ${a.report.patient_name || 'the person'}${a.report.patient_age ? ', ' + a.report.patient_age : ''}${a.report.patient_sex ? ', ' + a.report.patient_sex : ''}.
Report: ${a.report.type || 'Lab report'}, ${a.report.date || ''}${a.report.lab ? ', ' + a.report.lab : ''}.
ALL ${a.total} RESULTS:
${a.grouped.flatMap((g) => g.params.map((x) => `[${g.category}] ${x.name}: ${x.value}${x.unit ? ' ' + x.unit : ''} | range ${x.ref_text || 'not printed'} | ${x.status.toUpperCase()}${x.deviation_pct ? ` (${x.deviation_pct}% beyond)` : ''}${x.trend ? ` | previous ${x.trend.previous} on ${x.trend.previous_date}` : ''}`)).join('\n')}
${a.qualitative.length ? 'TEXT RESULTS:\n' + a.qualitative.map((q) => `${q.name}: ${q.result}${q.ref_text ? ' (normal: ' + q.ref_text + ')' : ''}`).join('\n') : ''}

Return ONLY JSON:
{"overview":"3-4 plain sentences: the overall picture, which sections the report covers, how many values are outside range",
 "abnormal":[{"name":"exactly as above","what_it_measures":"one plain sentence","what_it_may_relate_to":"one sentence, phrased 'may relate to…' — commonly associated factors, never a diagnosis","how_far":"slightly / moderately / well above or below"}],
 "sections":[{"category":"as above","summary":"one sentence on the section as a whole"}],
 "trends":["each notable change vs the previous report, quoting both values and dates"],
 "patterns":["only if several values point the same way, one sentence each, e.g. 'Sugar markers (HbA1c, fasting glucose) are both above range'"],
 "discuss_with_doctor":["3-5 specific questions referencing the actual values"],
 "reassurance":"one calm sentence on what is normal in this report"}
Cover EVERY out-of-range value in "abnormal". Warm, precise, never alarming. Every concern points to the doctor.`;

export async function narrate(analysis, call = callModel) {
  return callJSON({ tier: 'analyse', content: ANALYSE_PROMPT(analysis), maxTokens: 3000 }, call);
}
