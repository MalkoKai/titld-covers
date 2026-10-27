import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { coverKey } from '../src/keys.mjs';
import { CLASSES, compress } from '../src/compress.mjs';
import { work } from '../src/sources.mjs';
import { runOnce } from '../src/run.mjs';
import { workerApi } from '../src/worker_api.mjs';

const HC = 'https://assets.hardcover.app';
const MT = 'https://static.metron.cloud';

// The worker's private covers routes (backend/worker/src/covers_job.ts),
// answered from SQLite with the same queries.
function memoryApi() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE comic_series (id INTEGER PRIMARY KEY, cover_url TEXT);
    CREATE TABLE comic_issues (series_id INTEGER NOT NULL, id INTEGER NOT NULL, image TEXT, PRIMARY KEY (series_id, id));
    CREATE TABLE title_index (rowid INTEGER PRIMARY KEY, type TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE cover_queue (key TEXT PRIMARY KEY, url TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE cover_wanted (series_id INTEGER PRIMARY KEY, at INTEGER NOT NULL);`);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const calls = [];
  return {
    db,
    calls,
    queue: async (after) => all('SELECT key, url FROM cover_queue WHERE key > ? ORDER BY key LIMIT 500', after),
    wanted: async () => all('SELECT w.series_id, s.cover_url FROM cover_wanted w LEFT JOIN comic_series s ON s.id = w.series_id ORDER BY w.at DESC LIMIT 20'),
    seriesIssues: async (series, after) => all('SELECT id, image FROM comic_issues WHERE series_id = ? AND id > ? ORDER BY id LIMIT 500', series, after),
    series: async (after) => all('SELECT id, cover_url FROM comic_series WHERE id > ? AND cover_url IS NOT NULL ORDER BY id LIMIT 500', after),
    books: async (after) => all("SELECT rowid AS id, json_extract(json, '$.imageUrl') AS url FROM title_index WHERE rowid > ? AND type = 'book' ORDER BY rowid LIMIT 500", after),
    issues: async ([series, id]) => all('SELECT series_id, id, image FROM comic_issues WHERE (series_id, id) > (?, ?) AND image IS NOT NULL ORDER BY series_id, id LIMIT 500', series, id),
    async done({ queue = [], wanted = [] }) {
      calls.push({ queue, wanted });
      for (const key of queue) db.prepare('DELETE FROM cover_queue WHERE key = ?').run(key);
      for (const id of wanted) db.prepare('DELETE FROM cover_wanted WHERE series_id = ?').run(id);
    },
  };
}

function memoryR2(existing = {}) {
  const objects = new Map(Object.entries(existing).map(([key, size]) => [key, { body: Buffer.alloc(0), size }]));
  return {
    objects,
    async list() { return [...objects].map(([key, o]) => ({ key, size: o.size })); },
    async put(key, body, type) { objects.set(key, { body, type, size: body.length }); },
    async get(key) { return objects.get(key)?.body ?? null; },
  };
}

const jpeg = (width, height, quality = 90, sigma = 6) =>
  sharp({ create: { width, height, channels: 3, background: { r: 120, g: 80, b: 160 }, noise: { type: 'gaussian', mean: 128, sigma } } }).jpeg({ quality }).toBuffer();

const images = (map) => async (url) => {
  const body = map[url];
  if (body instanceof Error) throw body;
  if (!body) throw new Error(`404 ${url}`);
  return body;
};

const options = (api, r2, fetchImage, extra = {}) => ({ api, r2, fetchImage, now: Date.parse('2026-10-28T00:00:00Z'), budgetMs: 60_000, capBytes: 9.5 * 1024 ** 3, metronGapMs: 0, ...extra });

test('job keys match the worker keys', () => {
  assert.equal(coverKey(`${HC}/editions/31544885/72ed6606-0392.jpg`, 'f'), 'hc/f/editions/31544885/72ed6606-0392.webp');
  assert.equal(coverKey(`${HC}/external_data/60657104/60d4dd14?w=300`, 't'), 'hc/t/external_data/60657104/60d4dd14.webp');
  assert.equal(coverKey(`${MT}/media/issue/2018/11/11/6497376-01.jpg`, 'f'), 'mt/f/media/issue/2018/11/11/6497376-01.webp');
  assert.equal(coverKey('https://images.igdb.com/igdb/image/upload/t_cover_big/x.jpg', 'f'), null);
});

test('a large cover becomes a 720 px WebP under 120 KB', async () => {
  const { body, type, kept } = await compress(await jpeg(1500, 2254), 'f');
  const meta = await sharp(body).metadata();
  assert.equal(type, 'image/webp');
  assert.equal(kept, false);
  assert.equal(meta.width, 720);
  assert.ok(body.length < CLASSES.f.ceiling, String(body.length));
});

test('thumbnails are 300 px', async () => {
  const { body } = await compress(await jpeg(1500, 2254), 't');
  assert.equal((await sharp(body).metadata()).width, 300);
});

test('a small source is kept as it is', async () => {
  // Busy detail saved as a heavily compressed JPEG: WebP at q50 comes out bigger.
  const source = await jpeg(300, 450, 15, 60);
  const result = await compress(source, 't');
  assert.equal(result.kept, true);
  assert.equal(result.type, 'image/jpeg');
  assert.ok(result.body.equals(source));
});

test('a non-image or broken cover is counted and skipped', async () => {
  const api = memoryApi();
  api.db.exec(`INSERT INTO cover_queue VALUES ('hc/f/a.webp', '${HC}/a.jpg', 1), ('hc/f/b.webp', '${HC}/b.jpg', 2)`);
  const r2 = memoryR2();
  const report = await runOnce(options(api, r2, images({ [`${HC}/a.jpg`]: Buffer.from('<html>no</html>'), [`${HC}/b.jpg`]: await jpeg(400, 600) })));
  assert.equal(report.failed, 1);
  assert.deepEqual([...r2.objects.keys()].filter((k) => !k.startsWith('_state/')), ['hc/f/b.webp']);
  assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM cover_queue').get().n, 0);
});

test('sources come in order: queue, opened series, series, books, issues', async () => {
  const api = memoryApi();
  api.db.exec(`INSERT INTO cover_queue VALUES ('hc/f/q.webp', '${HC}/q.jpg', 1);
    INSERT INTO cover_wanted VALUES (2, 1);
    INSERT INTO comic_series VALUES (1, '${MT}/s1.jpg'), (2, '${MT}/s2.jpg');
    INSERT INTO comic_issues VALUES (1, 11, '${MT}/i11.jpg'), (2, 21, '${MT}/i21.jpg');
    INSERT INTO title_index VALUES (1, 'book', '{"imageUrl":"${HC}/b1.jpg"}'), (2, 'movie', '{"imageUrl":"https://x/m.jpg"}');`);
  const keys = [];
  for await (const item of work(api, {}, Date.parse('2026-10-28T00:00:00Z'))) {
    keys.push(item.key);
    await item.done?.();
  }
  assert.deepEqual(keys, ['hc/f/q.webp', 'mt/f/s2.webp', 'mt/t/i21.webp', 'mt/f/s1.webp', 'mt/f/s2.webp', 'hc/f/b1.webp', 'mt/t/i11.webp', 'mt/t/i21.webp']);
  assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM cover_wanted').get().n, 0);
});

test('a present key is not fetched again and its queue row is deleted', async () => {
  const api = memoryApi();
  api.db.exec(`INSERT INTO cover_queue VALUES ('hc/f/a.webp', '${HC}/a.jpg', 1)`);
  const fetched = [];
  const report = await runOnce(options(api, memoryR2({ 'hc/f/a.webp': 10 }), async (url) => { fetched.push(url); throw new Error('no'); }));
  assert.deepEqual(fetched, []);
  assert.equal(report.skipped, 1);
  assert.equal(api.db.prepare('SELECT COUNT(*) AS n FROM cover_queue').get().n, 0);
});

test('the run stops at the byte cap and saves its cursors', async () => {
  const api = memoryApi();
  api.db.exec(`INSERT INTO comic_series VALUES (1, '${MT}/s1.jpg'), (2, '${MT}/s2.jpg')`);
  const r2 = memoryR2({ 'old.webp': 1000 });
  const report = await runOnce(options(api, r2, images({ [`${MT}/s1.jpg`]: await jpeg(400, 600), [`${MT}/s2.jpg`]: await jpeg(400, 600) }), { capBytes: 1001 }));
  assert.equal(report.stopped, 'cap');
  assert.equal(report.uploaded.f, 1);
  assert.ok(r2.objects.has('_state/cursors.json'));
});

test('the run stops at its time budget', async () => {
  const api = memoryApi();
  api.db.exec(`INSERT INTO comic_series VALUES (1, '${MT}/s1.jpg'), (2, '${MT}/s2.jpg')`);
  const report = await runOnce(options(api, memoryR2(), images({ [`${MT}/s1.jpg`]: await jpeg(400, 600), [`${MT}/s2.jpg`]: await jpeg(400, 600) }), { budgetMs: 0 }));
  assert.equal(report.stopped, 'time');
  assert.equal(report.uploaded.f + report.uploaded.t, 0);
});

test('Metron images are fetched one at a time, a gap apart', async () => {
  const api = memoryApi();
  api.db.exec(`INSERT INTO comic_series VALUES (1, '${MT}/s1.jpg'), (2, '${MT}/s2.jpg'), (3, '${MT}/s3.jpg')`);
  const body = await jpeg(200, 300);
  const spans = [];
  let open = 0;
  let overlap = false;
  const fetchImage = async () => {
    const start = Date.now();
    if (++open > 1) overlap = true;
    await new Promise((r) => setTimeout(r, 5));
    open--;
    spans.push(start);
    return body;
  };
  await runOnce(options(api, memoryR2(), fetchImage, { metronGapMs: 40 }));
  assert.equal(overlap, false);
  assert.equal(spans.length, 3);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i] - spans[i - 1] >= 38, String(spans[i] - spans[i - 1]));
});

test('walks rest 30 days after a full pass', async () => {
  const api = memoryApi();
  api.db.exec(`INSERT INTO comic_series VALUES (1, '${MT}/s1.jpg')`);
  const now = Date.parse('2026-10-28T00:00:00Z');
  const keys = [];
  for await (const item of work(api, { finished: now - 86_400_000 }, now)) keys.push(item.key);
  assert.deepEqual(keys, []);
  for await (const item of work(api, { finished: now - 31 * 86_400_000 }, now)) keys.push(item.key);
  assert.deepEqual(keys, ['mt/f/s1.webp']);
});

test('the worker client sends the job key and reads rows', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.Authorization, method: init?.method ?? 'GET', body: init?.body });
    return Response.json(String(url).endsWith('/done') ? { ok: true } : { rows: [{ key: 'hc/f/a b.webp' }] });
  };
  const api = workerApi({ base: 'https://api.test/', key: 'secret', fetchFn });
  assert.deepEqual(await api.queue('hc/f/a b.webp'), [{ key: 'hc/f/a b.webp' }]);
  await api.issues([3, 7]);
  await api.done({ queue: ['k'], wanted: [2] });
  assert.equal(seen[0].url, 'https://api.test/internal/covers/queue?after=hc%2Ff%2Fa+b.webp');
  assert.equal(seen[1].url, 'https://api.test/internal/covers/issues?after=3%3A7');
  assert.ok(seen.every((call) => call.auth === 'Bearer secret'));
  assert.deepEqual([seen[2].method, JSON.parse(seen[2].body)], ['POST', { queue: ['k'], wanted: [2] }]);
});

test('a refused worker call stops the run', async () => {
  const api = workerApi({ base: 'https://api.test', key: 'wrong', fetchFn: async () => Response.json({ error: 'Unauthorized' }, { status: 401 }) });
  await assert.rejects(api.series(0), /401/);
});
