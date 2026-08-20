/**
 * The stage background photo.
 *
 * Kept in IndexedDB rather than localStorage: localStorage holds strings, so
 * an image would have to be base64 (about 1.37x its real size) inside the
 * same ~5MB budget the solves live in. A single phone photo would fill it and
 * the next `save()` would fail -- losing solves to store a wallpaper. The
 * photo is per-device by design; it never enters the sync store.
 */

const DB = 'cube-timer'
const STORE = 'assets'
const KEY = 'background'

/** Long edge, in pixels, that an imported photo is reduced to. */
const MAX_EDGE = 2560
/** WebP quality: visually clean at a fraction of the original weight. */
const QUALITY = 0.82

/**
 * Fits a source image inside a square bound, preserving aspect ratio and
 * never upscaling. Pure, so the arithmetic is testable without a canvas.
 */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export function loadBackground(): Promise<Blob | null> {
  return tx<Blob | undefined>('readonly', (s) => s.get(KEY))
    .then((v) => v ?? null)
    .catch(() => null)
}

export function saveBackground(blob: Blob): Promise<void> {
  return tx('readwrite', (s) => s.put(blob, KEY)).then(() => undefined)
}

export function clearBackground(): Promise<void> {
  return tx('readwrite', (s) => s.delete(KEY)).then(() => undefined)
}

/**
 * Decodes a chosen file, caps its long edge and re-encodes it.
 *
 * A 6MB photo lands in the low hundreds of KB, which keeps IndexedDB small
 * and the paint cheap. Re-encoding also drops the EXIF block, so location
 * data in a phone photo never reaches storage.
 */
export async function prepareImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.drawImage(bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', QUALITY),
    )
    if (!blob) throw new Error('could not encode image')
    return blob
  } finally {
    bitmap.close()
  }
}
