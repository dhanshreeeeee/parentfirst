ALTER TABLE families ADD COLUMN IF NOT EXISTS join_code TEXT UNIQUE;
ALTER TABLE families ALTER COLUMN join_code SET DEFAULT upper(substr(md5(random()::text),1,6));
UPDATE families SET join_code = upper(substr(md5(random()::text),1,6)) WHERE join_code IS NULL;
