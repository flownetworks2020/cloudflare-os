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
