// The Titld worker's private covers routes (backend/worker/src/covers_job.ts):
// the covers to copy, a page at a time, and the queue rows handled. The job
// holds only COVERS_JOB_KEY, which can do nothing else; it never gets a
// database token.

export function workerApi({ base, key, fetchFn = fetch }) {
  const root = `${base.replace(/\/+$/, '')}/internal/covers/`;
  const headers = { Authorization: `Bearer ${key}` };
  const call = async (path, init = {}) => {
    const response = await fetchFn(root + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`worker ${path.split('?')[0]}: ${response.status} ${body?.error ?? ''}`.trim());
    return body;
  };
  const rows = async (path, params = {}) => (await call(`${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`)).rows ?? [];
  return {
    queue: (after) => rows('queue', { after }),
    wanted: () => rows('wanted'),
    seriesIssues: (series, after) => rows('series-issues', { series, after }),
    series: (after) => rows('series', { after }),
    books: (after) => rows('books', { after }),
    issues: ([series, id]) => rows('issues', { after: `${series}:${id}` }),
    done: ({ queue = [], wanted = [] }) =>
      call('done', { method: 'POST', body: JSON.stringify({ queue, wanted }), headers: { 'Content-Type': 'application/json' } }),
  };
}
