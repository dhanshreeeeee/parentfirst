import { startFakeModel } from './fake-anthropic.mjs'; import fs from 'node:fs';
const f=startFakeModel(4700,{realValue:Number(process.argv[2])});
setInterval(()=>fs.writeFileSync('/tmp/fake_log.json',JSON.stringify(f.log)),100);
