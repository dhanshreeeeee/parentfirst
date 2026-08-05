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

function findValueNear(text, alias) {
  let idx = text.indexOf(alias);
  while (idx !== -1) {
    let window = text.slice(idx + alias.length, idx + alias.length + 50);
    // drop any leading "(...)" method/label note like "(25-OH)" before the value
    window = window.replace(/^\s*\([^)]*\)/, '');
    // a result is a number that is NOT immediately part of a range/word:
    // grab the first standalone number, not one glued to a letter or hyphen-range
    const m = window.match(/[:\s]+([0-9]{1,4}(?:\.[0-9]{1,2})?)(?![0-9.\-])/);
    if (m) return parseFloat(m[1]);
    idx = text.indexOf(alias, idx + alias.length);
  }
  return null;
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
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    if (seen.has(canonical)) continue;
    for (const alias of aliases) {
      const v = findValueNear(lower, alias);
      if (v == null) continue;
      const [lo, hi] = SANITY[canonical] || [-Infinity, Infinity];
      if (v < lo || v > hi) continue;
      params.push({ name: canonical, value: v, unit: UNIT_HINTS[canonical] || null });
      seen.add(canonical);
      break;
    }
  }

  return {
    ok: params.length >= 4,           // enough signal to trust the free path
    reason: params.length >= 4 ? 'ok' : `only ${params.length} params found`,
    type: 'Blood Report',
    lab: guessLab(lower),
    doctor: null,
    date: guessDate(lower),
    params,
  };
}
