import { readFile } from 'node:fs/promises';
import { compress } from './compress.mjs';
import { fetchImage } from './run.mjs';

// Compresses the real covers in test/sample-urls.json at their size class
// and prints the average per class, to check the bucket's size projection
// before a bulk run. Uploads nothing; Metron images one a second.

const urls = JSON.parse(await readFile(new URL('../test/sample-urls.json', import.meta.url), 'utf8'));
for (const size of ['f', 't']) {
  let bytes = 0;
  let source = 0;
  let count = 0;
  let kept = 0;
  for (const url of urls[size]) {
    if (url.includes('static.metron.cloud')) await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const original = await fetchImage(url);
      const result = await compress(original, size);
      bytes += result.body.length;
      source += original.length;
      kept += result.kept ? 1 : 0;
      count++;
    } catch (error) {
      console.error(`${url}: ${error.message}`);
    }
  }
  console.log(`${size}: ${count} covers, ${(source / count / 1024).toFixed(1)} KB → ${(bytes / count / 1024).toFixed(1)} KB on average, ${kept} kept as they were`);
}
