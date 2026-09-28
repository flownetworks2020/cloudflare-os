import { describe, expect, it } from "vitest";
import { writeColdCaptureContent } from "../src/cold-capture";

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  putCalls = 0;

  async get(key: string): Promise<R2ObjectBody | null> {
    let bytes = this.objects.get(key);
    return bytes ? {arrayBuffer: async () => bytes.slice().buffer} as R2ObjectBody : null;
  }

  async put(key: string, value: Uint8Array, options?: R2PutOptions): Promise<R2Object | null> {
    this.putCalls += 1;
    if (options?.onlyIf && this.objects.has(key)) return null;
    this.objects.set(key, value.slice());
    return {} as R2Object;
  }
}

describe("writeColdCaptureContent", () => {
  it("uses the SHA-256 key and skips the second identical write", async () => {
    let bucket = new MemoryBucket();
    let bytes = new TextEncoder().encode("fixture workspace capture");

    let first = await writeColdCaptureContent(bucket, bytes);
    let second = await writeColdCaptureContent(bucket, bytes);

    expect(first.key).toMatch(/^[0-9a-f]{64}$/);
    expect(first.key).toBe(first.sha256);
    expect(first.written).toBe(true);
    expect(second).toEqual({...first, written: false});
    expect(bucket.objects).toHaveLength(1);
    expect(bucket.putCalls).toBe(1);
  });

  it("refuses a pre-existing key whose bytes differ", async () => {
    let bucket = new MemoryBucket();
    let bytes = new TextEncoder().encode("fixture workspace capture");
    let first = await writeColdCaptureContent(bucket, bytes);
    bucket.objects.set(first.key, new TextEncoder().encode("tampered capture"));

    await expect(writeColdCaptureContent(bucket, bytes)).rejects.toThrow(
      `Cold capture content collision for SHA-256 ${first.key}: existing bytes differ.`,
    );
    expect(bucket.putCalls).toBe(1);
  });
});
