-- ParentFirst — Migration 013: keep the reference range printed on the report itself
-- Idempotent. Run: psql -d parentfirst_vault -f db/migrations/013_param_ranges.sql

ALTER TABLE report_params ADD COLUMN IF NOT EXISTS ref_low  NUMERIC;
ALTER TABLE report_params ADD COLUMN IF NOT EXISTS ref_high NUMERIC;
ALTER TABLE report_params ADD COLUMN IF NOT EXISTS ref_text TEXT;

-- widen the fallback table so common Indian panels aren't left blank
INSERT INTO reference_ranges (name, min_value, max_value, unit) VALUES
  ('Sodium',              137,  145,  'mmol/L'),
  ('Potassium',           3.5,  5.5,  'mmol/L'),
  ('Chloride',            98,   107,  'mmol/L'),
  ('Bilirubin Total',     0.2,  1.3,  'mg/dL'),
  ('Bilirubin Direct',    0,    0.3,  'mg/dL'),
  ('Bilirubin Indirect',  0.1,  1.1,  'mg/dL'),
  ('AST',                 17,   49,   'U/L'),
  ('ALT',                 0,    50,   'U/L'),
  ('ALP',                 38,   126,  'U/L'),
  ('GGT',                 15,   73,   'U/L'),
  ('Total Protein',       6,    8.3,  'g/dL'),
  ('Albumin',             3.5,  5,    'g/dL'),
  ('Globulin',            2.3,  3.5,  'g/dL'),
  ('Urea',                17,   43,   'mg/dL'),
  ('Uric Acid',           3.5,  7.2,  'mg/dL'),
  ('Calcium',             8.6,  10.2, 'mg/dL'),
  ('ESR',                 0,    20,   'mm/hr'),
  ('RBC',                 4.5,  5.9,  'mil/uL'),
  ('Alkaline Phosphatase', 38,  126,  'U/L'),
  ('A/G Ratio',            0.8,  2,   'Ratio'),
  ('AST/ALT Ratio',        0.7,  1.4, 'Ratio'),
  ('Albumin/Globulin Ratio', 0.8, 2,  'Ratio'),
  ('SGPT',                 0,    50,  'U/L'),
  ('SGOT',                 17,   49,  'U/L'),
  ('Protein',              6,    8.3, 'g/dL')
ON CONFLICT (name) DO NOTHING;
