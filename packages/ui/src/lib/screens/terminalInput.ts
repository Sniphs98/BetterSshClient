// Terminal input is sent over `terminal_write` as a `Uint8Array` (§4.2). A single huge
// paste still goes out in bounded chunks, awaited one by one, so paint yields between
// them and the remote channel's window drains at its own pace. This is the pure split;
// the view owns the ordered dispatch.

/** The per-write byte cap. Small enough that a multi-MB paste streams without a
 *  visible stall (§9). */
export const INPUT_CHUNK = 8192;

/** Split `data` into <=`size` slices, in order. Empty input yields nothing; input at or
 *  below the cap yields a single slice (the ordinary keystroke path).
 *
 *  Each slice owns its own buffer: IPC's structured clone copies a typed array's whole
 *  backing `ArrayBuffer`, not just the view, so a `subarray` of a large paste would ship
 *  the entire paste with every chunk. */
export function chunkBytes(data: Uint8Array, size: number = INPUT_CHUNK): Uint8Array[] {
  if (data.length <= size) return data.length ? [ownBuffer(data)] : [];
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) {
    chunks.push(data.slice(i, i + size));
  }
  return chunks;
}

function ownBuffer(data: Uint8Array): Uint8Array {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
}
