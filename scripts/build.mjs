import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const output = resolve(root, 'dist');
const supabaseUrl = process.env.SUPABASE_URL || '';
const anonKey = process.env.SUPABASE_ANON_KEY || '';

if (supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(supabaseUrl)) {
  throw new Error('SUPABASE_URL must be your Supabase project URL (https://<project-ref>.supabase.co).');
}

mkdirSync(output, { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'catalog.js', 'strategy.js']) cpSync(resolve(root, file), resolve(output, file));
writeFileSync(resolve(output, 'config.js'), `window.APP_CONFIG = ${JSON.stringify({ SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: anonKey })};\n`);
console.log(`Static site prepared in ${output}`);
