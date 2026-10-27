import { coverKey } from './keys.mjs';

// The covers to copy, most wanted first, read through the Titld worker's
// private covers routes (src/worker_api.mjs):
//   1. cover_queue: Hardcover covers people were just shown (the worker
//      queues the ones the bucket lacks);
//   2. cover_wanted: comic series someone opened, their cover and issues;
//   3. every comic series cover;
//   4. every book cover in the title index (the seeded catalog);
//   5. every comic issue cover, as a thumbnail.
// Walks 3-5 keep their place in [state] and start again 30 days after a
// full pass. The worker answers a page (up to 500 rows) at a time.

const REST_MS = 30 * 24 * 3600 * 1000;

/** Handled queue rows, cleared 50 at a time: one worker call each. */
export class QueueDeletes {
  constructor(api) {
    this.api = api;
    this.keys = [];
  }

  async add(key) {
    this.keys.push(key);
    if (this.keys.length >= 50) await this.flush();
  }

  async flush() {
    const keys = this.keys.splice(0);
    if (keys.length > 0) await this.api.done({ queue: keys });
  }
}

const host = (url) => (url.startsWith('https://static.metron.cloud/') ? 'metron' : 'hardcover');

function item(url, size, done) {
  const key = typeof url === 'string' ? coverKey(url, size) : null;
  return key ? { key, url, host: host(url), done } : null;
}

/**
 * Yields { key, url, host, done? } in order. Walk cursors in [state] move
 * as items are taken, so the caller must finish every item it takes before
 * saving [state], then flush [deletes].
 */
export async function* work(api, state, now, deletes = new QueueDeletes(api)) {
  // 1. The queue, in key order; each row is cleared once handled.
  for (let after = ''; ;) {
    const rows = await api.queue(after);
    if (rows.length === 0) break;
    for (const row of rows) {
      const done = () => deletes.add(row.key);
      if (row.key === coverKey(row.url, row.key.split('/')[1])) yield { key: row.key, url: row.url, host: host(row.url), done };
      else await done();
    }
    after = rows.at(-1).key;
  }

  // 2. Opened series, newest first: cover, then issues; the row goes after the last.
  for (const { series_id: id, cover_url: cover } of await api.wanted()) {
    const forget = () => api.done({ wanted: [id] });
    const list = [item(cover, 'f')];
    for (let after = 0; ;) {
      const rows = await api.seriesIssues(id, after);
      if (rows.length === 0) break;
      list.push(...rows.map((row) => item(row.image, 't')));
      after = rows.at(-1).id;
    }
    const found = list.filter(Boolean);
    if (found.length === 0) await forget();
    for (const [i, entry] of found.entries()) yield i === found.length - 1 ? { ...entry, done: forget } : entry;
  }

  // 3-5. The walks, resting 30 days after a full pass.
  if (state.finished && now - state.finished < REST_MS) return;
  if (state.finished) Object.assign(state, { finished: 0, series: 0, books: 0, issues: [0, 0] });

  for (state.series ??= 0; ;) {
    const rows = await api.series(state.series);
    if (rows.length === 0) break;
    for (const row of rows) {
      state.series = row.id;
      const entry = item(row.cover_url, 'f');
      if (entry) yield entry;
    }
  }
  for (state.books ??= 0; ;) {
    const rows = await api.books(state.books);
    if (rows.length === 0) break;
    for (const row of rows) {
      state.books = row.id;
      const entry = item(row.url, 'f');
      if (entry) yield entry;
    }
  }
  for (state.issues ??= [0, 0]; ;) {
    const rows = await api.issues(state.issues);
    if (rows.length === 0) break;
    for (const row of rows) {
      state.issues = [row.series_id, row.id];
      const entry = item(row.image, 't');
      if (entry) yield entry;
    }
  }
  state.finished = now;
}
