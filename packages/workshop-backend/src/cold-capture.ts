import { createExportDeadline } from "./export-limits";

/** The host-owned dynamic-worker module used only while capturing gadget storage. */
export const COLD_CAPTURE_WRAPPER_MODULE = "capture-wrapper.js";

/**
 * The wrapper deliberately imports the gadget's server module instead of altering it. The only
 * code that enumerates storage is this host-owned method; gadget authors do not need to expose a
 * capture API of their own.
 */
export const COLD_CAPTURE_WRAPPER_SOURCE = `
import { Gadget as UserGadget } from "./server.js";

export class Gadget extends UserGadget {
  async __coldCaptureDump() {
    return Array.from((await this.ctx.storage.list()).entries());
  }
}
`;

export type ColdCaptureEntry = [string, unknown];

/** A capture result always distinguishes a failure to read from empty gadget storage. */
export type ColdCaptureResult =
  | { status: "captured", entries: ColdCaptureEntry[] }
  | { status: "unreadable", reason: string };

/** Calls the host wrapper under the same bounded deadline used by gadget exports. */
export async function readColdCapture(
    gadget: {__coldCaptureDump(): Promise<ColdCaptureEntry[]>},
): Promise<ColdCaptureResult> {
  const deadline = createExportDeadline("Gadget storage capture timed out.");
  try {
    return {status: "captured", entries: await deadline.race(gadget.__coldCaptureDump())};
  } catch (error) {
    return {
      status: "unreadable",
      reason: error instanceof Error ? error.message : "Gadget storage capture failed.",
    };
  } finally {
    deadline.clear();
  }
}

/** Immutable content-addressed storage for cold-capture payloads. */
export type ColdCaptureContent = {
  key: string;
  sha256: string;
  byteLength: number;
  written: boolean;
};

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/**
 * Store bytes under their SHA-256 digest without permitting an overwrite.
 *
 * The initial read avoids an R2 write for ordinary recaptures. The conditional
 * create closes the race with another capture that observed the same missing
 * key; a failed conditional create is checked again before it can be accepted
 * as the same-content no-op.
 */
export async function writeColdCaptureContent(
    bucket: Pick<R2Bucket, "get" | "put">, bytes: Uint8Array): Promise<ColdCaptureContent> {
  let sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
  let existing = await bucket.get(sha256);
  if (existing) {
    let existingBytes = new Uint8Array(await existing.arrayBuffer());
    if (!sameBytes(existingBytes, bytes)) {
      throw new Error(`Cold capture content collision for SHA-256 ${sha256}: existing bytes differ.`);
    }
    return {key: sha256, sha256, byteLength: bytes.byteLength, written: false};
  }

  let created = await bucket.put(sha256, bytes, {onlyIf: new Headers({"If-None-Match": "*"})});
  if (created) return {key: sha256, sha256, byteLength: bytes.byteLength, written: true};

  // A concurrent writer won the conditional create. Re-read rather than ever
  // retrying an unconditional put, so the key remains immutable.
  existing = await bucket.get(sha256);
  if (!existing) {
    throw new Error(`Cold capture content create for SHA-256 ${sha256} was not applied.`);
  }
  let existingBytes = new Uint8Array(await existing.arrayBuffer());
  if (!sameBytes(existingBytes, bytes)) {
    throw new Error(`Cold capture content collision for SHA-256 ${sha256}: existing bytes differ.`);
  }
  return {key: sha256, sha256, byteLength: bytes.byteLength, written: false};
}
