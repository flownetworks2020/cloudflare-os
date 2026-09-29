import { describe, expect, it } from "vitest";
import { buildColdCaptureManifests, writeColdCaptureContent } from "../src/cold-capture";

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

describe("buildColdCaptureManifests", () => {
  it("serializes only bounded pointers and capture identity", () => {
    let sentinel = "transcript-sentinel-not-for-manifest";
    let capturedObject = {
      collection: "chats",
      key: "chat-123",
      sha256: "a".repeat(64),
      byteLength: 42,
      contentKey: "a".repeat(64),
      transcript: sentinel,
      attachment: sentinel,
      gitObject: sentinel,
      grant: sentinel,
    };

    expect(capturedObject.transcript).toBe(sentinel);
    let manifests = buildColdCaptureManifests({
      workspaceId: "workspace-1",
      captureId: "capture-1",
      capturedAt: "2026-09-29T00:00:00.000Z",
      deploymentCommit: "b".repeat(40),
    }, [capturedObject]);

    expect(manifests).toEqual([{
      capture: {
        workspaceId: "workspace-1",
        captureId: "capture-1",
        capturedAt: "2026-09-29T00:00:00.000Z",
        deploymentCommit: "b".repeat(40),
      },
      objects: [{
        collection: "chats",
        key: "chat-123",
        sha256: "a".repeat(64),
        byteLength: 42,
        contentKey: "a".repeat(64),
      }],
    }]);
    expect(JSON.stringify(manifests)).not.toContain(sentinel);
  });

  it("splits a capture above one hundred objects without truncating it", () => {
    let objects = Array.from({length: 101}, (_, index) => ({
      collection: "gitObjects",
      key: `object-${index}`,
      sha256: index.toString(16).padStart(64, "0"),
      byteLength: index,
      contentKey: index.toString(16).padStart(64, "0"),
    }));

    let manifests = buildColdCaptureManifests({
      workspaceId: "workspace-1",
      captureId: "capture-1",
      capturedAt: "2026-09-29T00:00:00.000Z",
      deploymentCommit: "b".repeat(40),
    }, objects);

    expect(manifests.map(manifest => manifest.objects)).toHaveLength(2);
    expect(manifests.map(manifest => manifest.objects.length)).toEqual([100, 1]);
    expect(manifests.flatMap(manifest => manifest.objects.map(object => object.key))).toEqual(
      objects.map(object => object.key),
    );
  });
});
