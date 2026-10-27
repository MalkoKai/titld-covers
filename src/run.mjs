import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { compress } from './compress.mjs';
import { QueueDeletes, work } from './sources.mjs';
import { workerApi } from './worker_api.mjs';

// One scheduled run: copy the covers Titld's bucket lacks, most wanted first
// (src/sources.mjs), compressed (src/compress.mjs), until the time budget
// or the byte cap. Hardcover images 6 at a time; Metron images one at a
// time, half a second apart. A cover that cannot be fetched or decoded is
// counted and passed over; only a bucket or worker error stops the run.

const STATE_KEY = '_state/cursors.json';

/**
 * @returns {Promise<{ uploaded: { f: number, t: number }, bytes: { f: number, t: number }, kept: number, skipped: number, failed: number, totalBytes: number, stopped: 'done' | 'time' | 'cap' }>}
 */
export async function runOnce({ api, r2, fetchImage, now = Date.now(), budgetMs, capBytes, metronGapMs = 500, hardcoverAtOnce = 6 }) {
  const started = Date.now();
  const listed = await r2.list();
  const present = new Set(listed.map((object) => object.key));
  let total = listed.reduce((sum, object) => sum + object.size, 0);
  const saved = await r2.get(STATE_KEY);
  const state = saved ? JSON.parse(Buffer.from(saved).toString('utf8')) : {};
  const deletes = new QueueDeletes(api);
  const report = { uploaded: { f: 0, t: 0 }, bytes: { f: 0, t: 0 }, kept: 0, skipped: 0, failed: 0, totalBytes: total, stopped: 'done' };

  const pools = { hardcover: { open: 0, max: hardcoverAtOnce }, metron: { open: 0, max: 1, last: -Infinity } };
  const running = new Set();
  let fatal = null;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  // Room for any next item: a Hardcover slot, and Metron idle past its gap.
  const room = async () => {
    while (!fatal && (pools.hardcover.open >= pools.hardcover.max || pools.metron.open > 0 || Date.now() - pools.metron.last < metronGapMs)) await tick();
  };

  const copy = async (entry) => {
    const size = entry.key.split('/')[1];
    let body;
    let type;
    try {
      const source = await fetchImage(entry.url);
      ({ body, type, kept: entry.kept } = await compress(source, size));
    } catch (error) {
      report.failed++;
      console.error(JSON.stringify({ event: 'cover_failed', key: entry.key, error: String(error?.message ?? error) }));
      return;
    }
    await r2.put(entry.key, body, type);
    present.add(entry.key);
    total += body.length;
    report.uploaded[size]++;
    report.bytes[size] += body.length;
    if (entry.kept) report.kept++;
  };

  const items = work(api, state, now, deletes)[Symbol.asyncIterator]();
  try {
    while (!fatal) {
      await room();
      if (fatal) break;
      if (Date.now() - started >= budgetMs) { report.stopped = 'time'; break; }
      if (total >= capBytes) { report.stopped = 'cap'; break; }
      const { value: entry, done } = await items.next();
      if (done) break;
      if (present.has(entry.key)) {
        report.skipped++;
        await entry.done?.();
        continue;
      }
      const pool = pools[entry.host];
      pool.open++;
      if (entry.host === 'metron') pool.last = Date.now();
      const task = copy(entry)
        .then(() => entry.done?.())
        .catch((error) => { fatal ??= error; })
        .finally(() => { pool.open--; running.delete(task); });
      running.add(task);
    }
  } catch (error) {
    fatal ??= error;
  }
  await Promise.all(running);
  report.totalBytes = total;
  // Whatever happened, keep the place reached and the rows handled.
  await deletes.flush().catch((error) => { fatal ??= error; });
  await r2.put(STATE_KEY, Buffer.from(JSON.stringify(state)), 'application/json').catch((error) => { fatal ??= error; });
  if (fatal) throw fatal;
  return report;
}

// --- Production clients ---------------------------------------------------

/** The covers bucket through R2's S3 API. */
export async function s3Bucket({ accountId, accessKeyId, secretAccessKey, bucket }) {
  const { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: 'auto', endpoint: `https://${accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } });
  return {
    async list() {
      const all = [];
      let token;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
        for (const object of page.Contents ?? []) all.push({ key: object.Key, size: object.Size ?? 0 });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return all;
    },
    async put(key, body, type) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: type, CacheControl: 'public, max-age=31536000, immutable' }));
    },
    async get(key) {
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await object.Body.transformToByteArray());
      } catch (error) {
        if (error?.name === 'NoSuchKey') return null;
        throw error;
      }
    },
  };
}

/** One provider image, refused past 10 MB or 20 seconds. */
export async function fetchImage(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'TitldCovers/1.0 (+https://github.com/MalkoKai/titld-covers)' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > 10 * 1024 * 1024) throw new Error('over 10 MB');
  return Buffer.from(await response.arrayBuffer());
}

const kb = (bytes, count) => (count ? `${(bytes / count / 1024).toFixed(1)} KB` : '-');

async function main() {
  const env = process.env;
  const need = (name) => env[name] || (() => { throw new Error(`${name} is not set`); })();
  const accountId = need('CF_ACCOUNT_ID');
  const report = await runOnce({
    api: workerApi({ base: env.TITLD_API || 'https://titld-api.malkokaidev.workers.dev', key: need('COVERS_JOB_KEY') }),
    r2: await s3Bucket({ accountId, accessKeyId: need('R2_ACCESS_KEY_ID'), secretAccessKey: need('R2_SECRET_ACCESS_KEY'), bucket: env.COVERS_BUCKET || 'titld-covers' }),
    fetchImage,
    budgetMs: Number(env.BUDGET_MINUTES || 50) * 60_000,
    capBytes: 9.5 * 1024 ** 3,
  });
  console.log(JSON.stringify({ event: 'covers_run', ...report }));
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, [
      '## Covers run',
      '',
      '| | Uploaded | Average |',
      '|---|---|---|',
      `| Title covers (720 px) | ${report.uploaded.f} | ${kb(report.bytes.f, report.uploaded.f)} |`,
      `| Thumbnails (300 px) | ${report.uploaded.t} | ${kb(report.bytes.t, report.uploaded.t)} |`,
      '',
      `Kept as they were: ${report.kept} · already there: ${report.skipped} · failed: ${report.failed} · stopped: ${report.stopped}`,
      `Bucket: ${(report.totalBytes / 1024 ** 3).toFixed(2)} GB of the 9.5 GB cap`,
      '',
    ].join('\n'));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
