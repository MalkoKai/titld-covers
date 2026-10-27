# Titld covers

Copies the book and comic covers Titld shows into its own Cloudflare R2 bucket, compressed, on a schedule. The app never loads covers from Hardcover or Metron. Hardcover asks professional projects not to hot-link its images, and Metron's servers may only be called by a scheduled job.

The Titld worker points every Hardcover or Metron image at a key in the bucket (`cover:hc/f/…`, `cover:mt/t/…`). It also queues any Hardcover cover the bucket lacks. This job reads its work from the worker's private covers routes and fills the bucket:

1. **Queued covers:** Hardcover covers people were just shown.
2. **Opened series:** comic series someone opened, their cover and every issue.
3. **Series covers:** every comic series cover.
4. **Book covers:** every book cover in the title index.
5. **Issue covers:** every comic issue cover, as a thumbnail.

Walks 3–5 keep their place in `_state/cursors.json` in the bucket and start again 30 days after a full pass.

## Compression

| Class | Used for | Width | WebP quality |
|---|---|---|---|
| `f` | a title's own cover | at most 720 px | 50 |
| `t` | issues, editions, people | at most 300 px | 50 |

- Images are never enlarged, and metadata is removed.
- A cover still over 120 KB (`f`) or 30 KB (`t`) is encoded again 10 quality points lower.
- A JPEG or WebP that is already narrow enough and smaller than the WebP version is stored unchanged.
- Uploads stop at 9.5 GB, inside R2's free 10 GB.

Run `npm run sample` to check the averages on 40 real covers. It uploads nothing.

## Secrets

| Secret | What |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account ID (for the R2 endpoint) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 API token with Object Read & Write on `titld-covers` only |
| `COVERS_JOB_KEY` | The key for the worker's private `/internal/covers/` routes; the same value is the worker secret `COVERS_JOB_KEY` |

The job reads its work list through the worker and has no database token. A leaked `COVERS_JOB_KEY` can only read the list of covers to copy and clear the two cover queues. The workflow's actions are pinned to exact commits, and fork pull requests never receive secrets.

## Running

The workflow runs every three hours, for up to 50 minutes each run. To start a run by hand:

```bash
gh workflow run covers.yml
```

Run the tests with `npm test`.
