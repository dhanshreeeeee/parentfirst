// A stand-in for the model API, so the full upload flow can be tested without a key.
import http from 'node:http';
export function startFakeModel(port, { realValue, patient = 'Mr Ramesh Kumar' }) {
  const log = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      const j = JSON.parse(body); log.push(j.model);
      const text = j.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      let out;
      if (/Transcribe it into JSON/.test(text)) out = {
        type: 'Complete Health Checkup', lab: 'Test Lab', doctor: '', date: '2025-12-05',
        patient_name: patient, patient_age: '54 Years', patient_sex: 'M',
        params: [
          { name: 'Sodium (Na+)', value: realValue, unit: 'mmol/L', ref_low: 136, ref_high: 145, ref_text: '136 - 145', category: 'Electrolytes' },
          { name: 'HbA1c', value: 8.8811, unit: '%', ref_low: 4, ref_high: 5.7, ref_text: '4.0 - 5.7', category: 'Sugar', flag: 'H' },
          { name: 'Made Up Test', value: 777.77, unit: 'U', category: 'Other' },
        ],
        qualitative: [{ name: 'Urine colour', result: 'Pale yellow', ref_text: 'Pale yellow', category: 'Urine' }],
      };
      else if (/could not be matched/.test(text)) out = { checks: [
        { name: 'HbA1c', present: true, printed_value: 6.2 }, { name: 'Made Up Test', present: false, printed_value: null } ] };
      else if (/health-literacy assistant reading ONE lab report/.test(text)) out = {
        overview: 'Two sections are covered. One value is outside its range.', abnormal: [{ name: 'HbA1c', what_it_measures: 'Average blood sugar over about three months.', what_it_may_relate_to: 'May relate to how blood sugar has been running.', how_far: 'slightly above' }],
        sections: [{ category: 'Sugar', summary: 'HbA1c is slightly above range.' }], trends: [], patterns: [],
        discuss_with_doctor: ['Is an HbA1c of 6.2% something to act on?'], reassurance: 'Sodium is within range.' };
      else out = { ok: true };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(out) }] }));
    });
  });
  srv.listen(port);
  return { close: () => srv.close(), log };
}
