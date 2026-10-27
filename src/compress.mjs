import sharp from 'sharp';

// Lossy WebP, slowest encoder setting, as Titld's other image pipelines
// (dice_roller theme packs use q82), with lower qualities chosen to keep
// every cover inside R2's free 10 GB: on 90 real covers a title cover
// averages ~31 KB (books) and ~69 KB (comic series), an issue thumbnail ~25 KB.

/** Size classes: "f" a title's own cover, "t" a thumbnail (issues, editions, people). */
export const CLASSES = {
  f: { width: 720, quality: 50, ceiling: 120 * 1024 },
  t: { width: 300, quality: 50, ceiling: 30 * 1024 },
};

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/**
 * [source] ready to store: at most the class width (never enlarged), WebP,
 * metadata stripped, encoded once more 10 quality points lower when over
 * the class ceiling. A JPEG or WebP source already within the width and
 * smaller than the encode is kept byte for byte. Throws on input that is
 * not an image or is over 10 MB.
 *
 * @returns {Promise<{ body: Buffer, type: string, kept: boolean }>}
 */
export async function compress(source, size) {
  if (source.length > MAX_SOURCE_BYTES) throw new Error('source over 10 MB');
  const { width, quality, ceiling } = CLASSES[size];
  const meta = await sharp(source).metadata();
  const encode = (q) => sharp(source).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: q, effort: 6 }).toBuffer();
  let body = await encode(quality);
  if (body.length > ceiling) body = await encode(quality - 10);
  if ((meta.format === 'jpeg' || meta.format === 'webp') && (meta.width ?? Infinity) <= width && source.length < body.length) {
    return { body: source, type: `image/${meta.format}`, kept: true };
  }
  return { body, type: 'image/webp', kept: false };
}
