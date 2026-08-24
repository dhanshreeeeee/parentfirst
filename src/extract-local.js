// Free, local extraction: pull text from a digital PDF and rule-match known
// blood parameters. No API cost. Returns null-ish result when it can't cope
// (scanned/image PDF with no text, or too few values found) so the caller
// can fall back to AI.
//
import { PDFParse } from 'pdf-parse';

// canonical name -> list of aliases that may appear in reports (lowercased)
const ALIASES = {
  'Hemoglobin':        ['hemoglobin', 'haemoglobin', 'hb ', 'hb('],
  'HbA1c':             ['hba1c', 'hba1c', 'glycated haemoglobin', 'glycated hemoglobin', 'glycosylated haemoglobin', 'glycosylated hemoglobin', 'hb a1c'],
  'Fasting Glucose':   ['fasting glucose', 'fasting blood sugar', 'glucose fasting', 'fbs', 'blood sugar fasting', 'fasting plasma glucose'],
  'Total Cholesterol': ['total cholesterol', 'cholesterol total', 'cholesterol, total', 'serum cholesterol'],
  'LDL Cholesterol':   ['ldl cholesterol', 'ldl-cholesterol', 'ldl ', 'ldl(', 'low density lipoprotein'],
  'HDL Cholesterol':   ['hdl cholesterol', 'hdl-cholesterol', 'hdl ', 'hdl(', 'high density lipoprotein'],
  'Triglycerides':     ['triglycerides', 'triglyceride', 'tg '],
  'Creatinine':        ['creatinine', 'serum creatinine'],
  'Vitamin D':         ['vitamin d (25-oh)', 'vitamin d(25-oh)', 'vitamin d', '25-hydroxy vitamin d', '25 hydroxy vitamin d', 'vit d'],
  'Vitamin B12':       ['vitamin b12', 'vitamin b-12', 'vit b12', 'cyanocobalamin', 'cobalamin'],
  'TSH':               ['tsh', 'thyroid stimulating hormone'],
  'Platelets':         ['platelet count', 'platelets', 'platelet '],
  'WBC':               ['wbc', 'white blood cell', 'total leucocyte', 'total leukocyte', 'tlc'],
};

const UNIT_HINTS = {
  'Hemoglobin': 'g/dL', 'HbA1c': '%', 'Fasting Glucose': 'mg/dL',
  'Total Cholesterol': 'mg/dL', 'LDL Cholesterol': 'mg/dL', 'HDL Cholesterol': 'mg/dL',
  'Triglycerides': 'mg/dL', 'Creatinine': 'mg/dL', 'Vitamin D': 'ng/mL',
  'Vitamin B12': 'pg/mL', 'TSH': 'mIU/L', 'Platelets': 'k/uL', 'WBC': 'k/uL',
};

// plausibility bounds — reject junk numbers grabbed from the wrong column
const SANITY = {
  'Hemoglobin': [3, 25], 'HbA1c': [3, 20], 'Fasting Glucose': [30, 600],
  'Total Cholesterol': [50, 500], 'LDL Cholesterol': [20, 400], 'HDL Cholesterol': [10, 150],
  'Triglycerides': [20, 1000], 'Creatinine': [0.1, 15], 'Vitamin D': [2, 200],
  'Vitamin B12': [50, 2000], 'TSH': [0.01, 60], 'Platelets': [10, 1000], 'WBC': [1, 50],
};

// Pull the RESULT value for a parameter, not a number from its reference range.
// Strategy: look at the line containing the alias (plus a little after), remove
// any printed reference interval first (e.g. "4 - 5.7", "0.66-1.25", "< 50",
// "up to 2.0", "137 145"), then take the first remaining standalone number.
// Returns { value, confident } — confident=false when the line still had a
// range-like shape we couldn't disentangle, so the caller can prefer AI.
function findValueNear(text, alias) {
  let idx = text.indexOf(alias);
  while (idx !== -1) {
    // take the rest of the line the alias sits on, plus a short spill for
    // reports that wrap the value onto the next visual column
    const after = text.slice(idx + alias.length, idx + alias.length + 120);
    const line = after.split(/\n/)[0] + ' ' + (after.split(/\n/)[1] || '');
    let w = line.replace(/^\s*\([^)]*\)/, ' '); // drop leading "(25-OH)" etc.

    // 1) note whether a reference interval is present (affects confidence)
    const hadRange = /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)|[<>]\s*\d|up to\s*\d|upto\s*\d/i.test(w);

    // 2) strip the reference interval so its numbers can't be misread as the result
    w = w.replace(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/g, ' ');       // 4 - 5.7
    w = w.replace(/[<>]\s*=?\s*\d+(?:\.\d+)?/g, ' ');                          // < 50 , >= 40
    w = w.replace(/\b(?:up ?to|upto|less than|greater than)\s*\d+(?:\.\d+)?/ig, ' ');
    w = w.replace(/ref(?:erence)?\.?\s*(?:range|interval|value)?[:\s]*\d[\d.\s-]*/ig, ' ');

    // 3) first standalone number left is the result
    const m = w.match(/(?:^|[:\s])([0-9]{1,4}(?:\.[0-9]{1,2})?)(?![0-9.])/);
    if (m) return { value: parseFloat(m[1]), confident: true };

    // 4) nothing left after stripping the range: the only numbers WERE the range —
    //    we can't tell the result apart. Signal low confidence.
    if (hadRange) return { value: null, confident: false };

    idx = text.indexOf(alias, idx + alias.length);
  }
  return { value: null, confident: true };
}

function guessDate(text) {
  // dd/mm/yyyy, dd-mm-yyyy, dd Mon yyyy, yyyy-mm-dd
  const iso = text.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const dmy = text.match(/\b(\d{1,2})[-/](\d{1,2})[-/](20\d{2})\b/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const dtxt = text.match(/\b(\d{1,2})[-\s]([a-z]{3})[a-z]*[-\s,]*\s*(20\d{2})\b/i);
  if (dtxt) {
    const mm = months[dtxt[2].toLowerCase().slice(0, 3)];
    if (mm) return `${dtxt[3]}-${mm}-${dtxt[1].padStart(2, '0')}`;
  }
  return null;
}

function guessLab(text) {
  const labs = ['Dr. Lal PathLabs', 'Lal PathLabs', 'SRL', 'Metropolis', 'Thyrocare',
    'Apollo', 'Agilus', '1mg', 'Redcliffe', 'Vijaya Diagnostic', 'Suburban Diagnostics'];
  for (const l of labs) if (text.includes(l.toLowerCase())) return l;
  return null;
}

export async function extractLocal(buffer) {
  let text = '';
  let parser;
  try {
    parser = new PDFParse({ data: buffer });
    const data = await parser.getText();
    text = (data.text || '');
  } catch {
    return { ok: false, reason: 'pdf-parse failed', params: [] };
  } finally {
    try { await parser?.destroy(); } catch { /* ignore */ }
  }

  const lower = text.toLowerCase();
  // no usable text ⇒ almost certainly a scanned image PDF ⇒ let AI handle it
  if (lower.replace(/\s/g, '').length < 40) {
    return { ok: false, reason: 'no extractable text (likely scanned)', params: [] };
  }

  const params = [];
  const seen = new Set();
  let lowConfidence = 0;
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    if (seen.has(canonical)) continue;
    for (const alias of aliases) {
      const r = findValueNear(lower, alias);
      if (r.value == null) { if (!r.confident) lowConfidence++; continue; }
      const [lo, hi] = SANITY[canonical] || [-Infinity, Infinity];
      if (r.value < lo || r.value > hi) continue;
      params.push({ name: canonical, value: r.value, unit: UNIT_HINTS[canonical] || null });
      seen.add(canonical);
      break;
    }
  }

  // Trust the free path ONLY when it read enough params AND wasn't defeated by
  // range/result ambiguity on several rows. Otherwise say "not ok" so the
  // caller uses AI vision — a correct value matters more than saving a call.
  const trustworthy = params.length >= 6 && lowConfidence <= 1;
  return {
    ok: trustworthy,
    reason: trustworthy ? 'ok' : `low confidence (params=${params.length}, ambiguous=${lowConfidence})`,
    type: 'Blood Report',
    lab: guessLab(lower),
    doctor: null,
    date: guessDate(lower),
    params,
  };
}
