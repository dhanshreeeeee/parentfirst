// Report intelligence pipeline — run with a fake model so it needs no API key.
// Uses a real Indian lab-report PDF when one is provided via REPORT_PDF.
import fs from 'node:fs';
import { textLayer, numbersIn, sanitizeParams, verifyAgainstText, runExtraction, buildAnalysis, narrate } from '../src/report-intel.js';
import { parseJSON, callJSON } from '../src/ai.js';

let P = 0, F = 0;
const t = (n, c, x) => { if (c) P++; else { F++; console.log('  ✗ ' + n + (x ? ' — ' + x : '')); } };
const PDF = process.env.REPORT_PDF;

// ── JSON robustness ──
t('parse fenced JSON', parseJSON('```json\n{"a":1}\n```').a === 1);
t('parse JSON with prose around it', parseJSON('Here you go: {"a":2} hope that helps').a === 2);
let tries = 0;
const flaky = async () => (++tries === 1 ? 'sorry, not json' : '{"ok":true}');
t('callJSON retries once on bad JSON', (await callJSON({ tier: 'fast', content: 'x' }, flaky)).ok === true && tries === 2);

// ── sanitising what a model returns ──
const s = sanitizeParams([
  { name: 'Hemoglobin', value: '11.4', unit: 'g/dL', ref_low: '13', ref_high: 17, ref_text: '13.0 - 17.0', category: 'Blood counts', flag: 'Low' },
  { name: 'Platelets', value: '1,42,000', category: 'Nonsense' },
  { name: 'Urine colour', value: 'Pale yellow' },
  { name: 'Hemoglobin', value: 11.4 },
  { name: '', value: 5 },
]);
t('numeric strings coerced, Indian commas handled', s[0].value === 11.4 && s[1].value === 142000, JSON.stringify(s.map((x) => x.value)));
t('text results kept out of numeric rows', !s.some((x) => x.name === 'Urine colour'));
t('duplicate row dropped', s.filter((x) => x.name === 'Hemoglobin').length === 1);
t('flag normalised, bad category → Other', s[0].flag === 'L' && s[1].category === 'Other');

if (PDF && fs.existsSync(PDF)) {
  const buf = fs.readFileSync(PDF);
  const text = await textLayer(buf);
  t('real PDF has a usable text layer', !!text && text.length > 1000, String(text && text.length));
  t('watermark lines stripped', !(text || '').split('\n').some((l, i, a) => a.indexOf(l) !== i && a.filter((x) => x === l).length >= 6));
  const nums = numbersIn(text || '');
  t('document numbers indexed', nums.size > 50, String(nums.size));
  const real = nums.has('141.9') ? 141.9 : [...nums].map(Number).find((n) => n > 100 && n < 200 && !Number.isInteger(n));
  const fakeHallucination = 777.77, fakeMisread = 9.8765;
  t('planted wrong values are genuinely absent', !nums.has(String(fakeHallucination)) && !nums.has(String(fakeMisread)));

  const calls = [];
  const fakeModel = async ({ tier, content }) => {
    calls.push(tier);
    if (tier === 'extract') return JSON.stringify({
      type: 'Health Checkup', lab: 'Test Lab', date: '2025-12-05', patient_name: 'Mr Ramesh Kumar', patient_age: '54 Years', patient_sex: 'M',
      params: [
        { name: 'Sodium (Na+)', value: real, unit: 'mmol/L', ref_low: 136, ref_high: 145, ref_text: '136 - 145', category: 'Electrolytes' },
        { name: 'Vitamin X', value: fakeHallucination, unit: 'ng/mL', category: 'Vitamins' },
        { name: 'Potassium (K+)', value: fakeMisread, unit: 'mmol/L', ref_low: 3.5, ref_high: 5.1, ref_text: '3.5 - 5.1', category: 'Electrolytes' },
      ],
      qualitative: [{ name: 'Urine colour', result: 'Pale yellow', ref_text: 'Pale yellow', category: 'Urine' }],
    });
    // second read, by the stronger model
    const asked = content.find((b) => b.type === 'text').text;
    t('second read only asks about the unmatched values', /Vitamin X/.test(asked) && /Potassium/.test(asked) && !/Sodium/.test(asked));
    return JSON.stringify({ checks: [
      { name: 'Vitamin X', present: false, printed_value: null },
      { name: 'Potassium (K+)', present: true, printed_value: 4.2 },
    ] });
  };
  const { obj, stats } = await runExtraction({ buf, mime: 'application/pdf', call: fakeModel });
  const by = (n) => obj.params.find((p) => p.name === n);
  t('extract used Sonnet tier, re-read used Opus tier', calls[0] === 'extract' && calls[1] === 'analyse', calls.join(','));
  t('correct value → verified against the document', by('Sodium (Na+)')?.verified === 'document');
  t('hallucinated test → removed', !by('Vitamin X') && stats.removed === 1);
  t('misread value → corrected to the printed value', by('Potassium (K+)')?.value === 4.2 && by('Potassium (K+)')?.verified === 'corrected' && by('Potassium (K+)')?.first_read === fakeMisread);
  t('text results carried separately', obj.qualitative.length === 1 && obj.qualitative[0].result === 'Pale yellow');
  t('patient details carried', obj.patient_name === 'Mr Ramesh Kumar');
  t('stats add up', stats.total === 2 && stats.document === 1 && stats.corrected === 1, JSON.stringify(stats));

  // second read failing must never silently trust a value
  const failingRecheck = async ({ tier }) => { if (tier === 'extract') return fakeModel({ tier, content: [] }); throw new Error('529 overloaded'); };
  calls.length = 0;
  const r2 = await runExtraction({ buf, mime: 'application/pdf', call: async (o) => (o.tier === 'extract' ? (await fakeModel({ tier: 'extract', content: [] })) : (() => { throw new Error('529'); })()) });
  t('if the second read fails, values stay UNVERIFIED (never trusted)', r2.obj.params.filter((p) => p.verified === 'unverified').length === 2);
} else {
  console.log('  (skipped real-PDF checks: set REPORT_PDF=path/to/report.pdf)');
}

// images have no text layer → everything goes to the second read
t('image upload: no text → unchecked', verifyAgainstText([{ name: 'a', value: 1 }], null)[0].verified === 'unchecked');

// ── analysis maths ──
const params = [
  { name: 'Hemoglobin', value: 11.4, unit: 'g/dL', ref_low: 13, ref_high: 17, ref_text: '13.0 - 17.0', category: 'Blood counts', lab_flag: 'L', verified: 'document' },
  { name: 'LDL Cholesterol', value: 148, unit: 'mg/dL', ref_low: null, ref_high: 100, ref_text: '< 100', category: 'Lipids', verified: 'document' },
  { name: 'HDL Cholesterol', value: 38, unit: 'mg/dL', ref_low: 40, ref_high: null, ref_text: '> 40', category: 'Lipids', verified: 'model' },
  { name: 'MCV', value: 82, unit: 'fL', ref_low: 80, ref_high: 100, ref_text: '80 - 100', category: 'Blood counts', verified: 'document' },
  { name: 'Uric Acid', value: 6.1, unit: 'mg/dL', category: 'Kidney', verified: 'document' },
];
const prev = [{ name: 'Hemoglobin', value: 12.1, report_date: '2026-06-01' }];
const a = buildAnalysis({ id: 'r1', report_type: 'Checkup', report_date: '2026-09-01' }, params, prev, (p) => (p.name === 'Uric Acid' ? { min: 3.5, max: 7.2 } : null));
const row = (n) => a.grouped.flatMap((g) => g.params).find((x) => x.name === n);
t('low + deviation (11.4 vs 13 → 12%)', row('Hemoglobin').status === 'low' && row('Hemoglobin').deviation_pct === 12);
t('"< 100" printed → high, 48% beyond', row('LDL Cholesterol').status === 'high' && row('LDL Cholesterol').deviation_pct === 48);
t('"> 40" printed → low', row('HDL Cholesterol').status === 'low');
t('in range → ok, no deviation', row('MCV').status === 'ok' && row('MCV').deviation_pct === null);
t('no printed range → standard range used + labelled', row('Uric Acid').range_source === 'standard' && row('Uric Acid').status === 'ok');
t('trend vs previous report', row('Hemoglobin').trend.previous === 12.1 && row('Hemoglobin').trend.direction === 'down' && row('Hemoglobin').trend.previous_date === '2026-06-01');
t('grouped in body-system order', a.grouped.map((g) => g.category).join(',') === 'Blood counts,Lipids,Kidney');
t('abnormal sorted worst first', a.abnormal[0].name === 'LDL Cholesterol');
t('verification summary', a.verification.document === 4 && a.verification.model === 1);
const n = await narrate(a, async ({ tier, content }) => { t('narrative uses Opus tier and sees every value', tier === 'analyse' && /LDL Cholesterol: 148/.test(content) && /48% beyond/.test(content)); return '{"overview":"ok","abnormal":[]}'; });
t('narrative parsed', n.overview === 'ok');

console.log(`\n${P} passed, ${F} failed`);
process.exit(F ? 1 : 0);
