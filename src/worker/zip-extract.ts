import { createWriteStream } from 'fs';
import { mkdir, readdir, rename, rm } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import yauzl from 'yauzl';

/**
 * Extracts a user-uploaded project zip for the import endpoint. The archive is
 * untrusted, so every entry is validated before anything touches disk:
 *  - no absolute paths, no `..` segments, no backslashes (zip-slip);
 *  - resolved target must stay inside destDir (belt and braces);
 *  - only regular files and directories — symlinks and specials are skipped
 *    (a symlink could alias later entries outside the tree);
 *  - anything under `.git/` is dropped: a planted `.git/hooks/*` would execute
 *    on the first checkout, and the import creates its own fresh repo anyway;
 *  - entry-count and total-uncompressed-size caps guard against zip bombs,
 *    counting actual streamed bytes (headers can lie).
 */

export const ZIP_LIMITS = {
  maxEntries: 20_000,
  maxTotalBytes: 400 * 1024 * 1024,
  maxFileBytes: 100 * 1024 * 1024,
};

export class ZipError extends Error {
  constructor(
    message: string,
    /** HTTP status the import route should map this to. */
    readonly status: number = 422
  ) {
    super(message);
  }
}

const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;

/** Returns null when the entry must be skipped, else the safe relative path. */
export const safeEntryPath = (
  fileName: string,
  destDir: string
): string | null => {
  if (!fileName || fileName.includes('\\')) return null;
  if (fileName.startsWith('/') || /^[a-zA-Z]:/.test(fileName)) return null;
  const segments = fileName.split('/').filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((s) => s === '..' || s === '.')) return null;
  // The import creates its own git repo; nothing from the archive's .git
  // (hooks, config) may land on disk. Also drop macOS resource-fork noise.
  if (segments[0] === '.git' || segments.includes('.git')) return null;
  if (segments[0] === '__MACOSX') return null;
  const target = resolve(destDir, segments.join('/'));
  if (target !== destDir && !target.startsWith(destDir + sep)) return null;
  return segments.join('/');
};

const entryMode = (entry: yauzl.Entry) =>
  (entry.externalFileAttributes >>> 16) & 0xffff;

/** True when the unix mode says regular file (or the zip has no unix info). */
const isRegularFile = (entry: yauzl.Entry) => {
  const type = entryMode(entry) & S_IFMT;
  return type === 0 || type === S_IFREG;
};

export const extractZip = async (
  zipPath: string,
  destDir: string,
  limits = ZIP_LIMITS
): Promise<{ files: number }> => {
  await mkdir(destDir, { recursive: true });
  const zipfile = await new Promise<yauzl.ZipFile>((res, rej) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zf) =>
      err ? rej(new ZipError('Not a valid zip file.')) : res(zf)
    );
  });

  let files = 0;
  let entries = 0;
  let totalBytes = 0;

  try {
    await new Promise<void>((done, fail) => {
      // yauzl itself hard-errors the whole archive on `..` segments, absolute
      // paths and malformed structure — exactly what we want for a hostile
      // upload: reject it entirely rather than extract around it.
      zipfile.on('error', () =>
        fail(new ZipError('Invalid or corrupt zip file.'))
      );
      zipfile.on('end', () => done());
      zipfile.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          entries += 1;
          if (entries > limits.maxEntries) {
            throw new ZipError(
              `Zip has more than ${limits.maxEntries} entries.`,
              413
            );
          }
          const rel = safeEntryPath(entry.fileName, destDir);
          const isDir =
            entry.fileName.endsWith('/') ||
            (entryMode(entry) & S_IFMT) === S_IFDIR;
          if (!rel) {
            zipfile.readEntry();
            return;
          }
          if (isDir) {
            await mkdir(join(destDir, rel), { recursive: true });
            zipfile.readEntry();
            return;
          }
          if (!isRegularFile(entry)) {
            // Symlinks and special files never touch disk.
            zipfile.readEntry();
            return;
          }
          if (entry.uncompressedSize > limits.maxFileBytes) {
            throw new ZipError(
              `A file in the zip is larger than ${Math.round(
                limits.maxFileBytes / (1024 * 1024)
              )} MB.`,
              413
            );
          }
          const stream = await new Promise<NodeJS.ReadableStream>(
            (res, rej) => {
              zipfile.openReadStream(entry, (err, s) =>
                err ? rej(new ZipError('Corrupt zip entry.')) : res(s)
              );
            }
          );
          // Count real streamed bytes — zip headers can understate sizes.
          // In-pipeline Transform, never a bare 'data' listener: that would
          // start the flow before the write stream is attached.
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              totalBytes += chunk.length;
              if (totalBytes > limits.maxTotalBytes) {
                callback(
                  new ZipError(
                    `Zip extracts to more than ${Math.round(
                      limits.maxTotalBytes / (1024 * 1024)
                    )} MB.`,
                    413
                  )
                );
                return;
              }
              callback(null, chunk);
            },
          });
          const target = join(destDir, rel);
          await mkdir(dirname(target), { recursive: true });
          await pipeline(stream, counter, createWriteStream(target));
          files += 1;
          zipfile.readEntry();
        })().catch(fail);
      });
      zipfile.readEntry();
    });
  } finally {
    zipfile.close();
  }
  return { files };
};

/**
 * GitHub-style zips wrap everything in one top-level folder. When extraction
 * yields exactly one directory and nothing else, hoist its contents so the
 * project root (index.html / package.json) sits at destDir.
 */
export const stripWrapperDir = async (destDir: string): Promise<void> => {
  const top = await readdir(destDir, { withFileTypes: true });
  if (top.length !== 1 || !top[0].isDirectory()) return;
  // Move the wrapper aside first so an inner entry sharing its name can land.
  const wrapper = join(destDir, '.__cp-wrapper');
  await rename(join(destDir, top[0].name), wrapper);
  const inner = await readdir(wrapper);
  for (const name of inner) {
    await rename(join(wrapper, name), join(destDir, name));
  }
  await rm(wrapper, { recursive: true, force: true });
};
