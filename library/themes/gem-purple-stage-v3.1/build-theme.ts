import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineLocalAssets } from '../../../runtime/apply-theme.ts';

async function main(): Promise<void> {
  const themeDir = path.dirname(fileURLToPath(import.meta.url));
  const source = await fs.readFile(path.join(themeDir, 'theme.source.css'), 'utf8');
  const css = await inlineLocalAssets(source, themeDir);
  const bytes = Buffer.byteLength(css);
  if (bytes >= 1_000_000) throw new Error(`theme.css is ${bytes} bytes; limit is < 1 MB`);
  await fs.writeFile(path.join(themeDir, 'theme.css'), css, 'utf8');
  console.log(JSON.stringify({ status: 'built', bytes, assetsEmbedded: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
