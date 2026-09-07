import { describe, expect, it } from "vitest";
import {
  admitContextCollectionWrite, CONTEXT_DOCUMENT_WRITE_SCHEMA, listRegisteredContextWriteSchemas,
} from "../src/governed-context.js";

describe("governed Context collection writes", () => {
  it("admits the locally registered document schema with server-governed provenance", () => {
    const admitted = admitContextCollectionWrite(CONTEXT_DOCUMENT_WRITE_SCHEMA, {
      path: "runbooks/incident.md",
      description: "How to respond to an incident.",
      body: "# Incident response",
    }, { actor: "account-123", packet: "collection-456" });

    expect(listRegisteredContextWriteSchemas()).toEqual([CONTEXT_DOCUMENT_WRITE_SCHEMA]);
    expect(admitted).toMatchObject({
      schema: CONTEXT_DOCUMENT_WRITE_SCHEMA,
      governance: { actor: "account-123", packet: "collection-456" },
      payload: { path: "runbooks/incident.md" },
    });
  });

  it("refuses an unregistered schema before a write can reach collection storage", () => {
    expect(() => admitContextCollectionWrite("context.collection.arbitrary.v1", {
      path: "runbooks/incident.md", description: "Ignored", body: "Ignored",
    }, { actor: "account-123", packet: "collection-456" })).toThrow(
      'schema "context.collection.arbitrary.v1" is not registered',
    );
  });
});
