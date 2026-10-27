// The R2 key for a provider image: the same rule as the Titld worker's
// src/covers.ts coverKey. Keep both in step: the app asks the bucket for the
// key the worker wrote, and only finds a cover if this job stored it there.
//
// "hc/" or "mt/", the size class ("f" a title's own cover, "t" a
// thumbnail), then the provider's path with ".webp" for its extension.

const HOSTS = {
  'assets.hardcover.app': 'hc',
  'static.metron.cloud': 'mt',
};

/** @returns {string | null} */
export function coverKey(url, size) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const prefix = HOSTS[parsed.hostname];
  const path = parsed.pathname.slice(1);
  if (!prefix || parsed.protocol !== 'https:' || !path || !/^[A-Za-z0-9._\-/]+$/.test(path) || path.includes('..')) return null;
  return `${prefix}/${size}/${path.replace(/\.[A-Za-z0-9]{1,5}$/, '')}.webp`;
}
