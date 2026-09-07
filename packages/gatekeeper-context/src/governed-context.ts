// Local schema admission for Context Library web writes. The management API derives the
// governing actor and collection packet; callers cannot supply or redirect either value.

/** The only payload schema the Context Library currently admits for web document writes. */
export const CONTEXT_DOCUMENT_WRITE_SCHEMA = "context.collection.document.v1";

export type ContextWriteGovernance = {
  actor: string;
  packet: string;
};

export type AdmittedContextDocumentWrite = {
  schema: typeof CONTEXT_DOCUMENT_WRITE_SCHEMA;
  governance: ContextWriteGovernance;
  payload: { path: string; description: string; body: string; contentType?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Context collection write refused: ${name} is required.`);
  }
}

function admitDocumentWrite(payload: unknown, governance: ContextWriteGovernance): AdmittedContextDocumentWrite {
  if (!isRecord(payload)) {
    throw new Error("Context collection write refused: payload must be an object.");
  }
  for (let key of Object.keys(payload)) {
    if (key !== "path" && key !== "description" && key !== "body" && key !== "contentType") {
      throw new Error(`Context collection write refused: document schema does not allow ${key}.`);
    }
  }
  assertNonEmptyString(payload.path, "path");
  if (typeof payload.description !== "string" || typeof payload.body !== "string") {
    throw new Error("Context collection write refused: document description and body must be strings.");
  }
  if (payload.contentType !== undefined && typeof payload.contentType !== "string") {
    throw new Error("Context collection write refused: contentType must be a string.");
  }
  assertNonEmptyString(governance.actor, "governing actor");
  assertNonEmptyString(governance.packet, "governing packet");

  return {
    schema: CONTEXT_DOCUMENT_WRITE_SCHEMA,
    governance: { actor: governance.actor, packet: governance.packet },
    payload: {
      path: payload.path,
      description: payload.description,
      body: payload.body,
      ...(payload.contentType === undefined ? {} : { contentType: payload.contentType }),
    },
  };
}

const registeredSchemas = new Map<string, (payload: unknown, governance: ContextWriteGovernance) => AdmittedContextDocumentWrite>([
  [CONTEXT_DOCUMENT_WRITE_SCHEMA, admitDocumentWrite],
]);

/** Returns the locally registered write schemas without exposing the mutable registry. */
export function listRegisteredContextWriteSchemas(): string[] {
  return [...registeredSchemas.keys()];
}

/**
 * Admits one Context Library write against its local schema registry. An unregistered schema is
 * refused before any collection storage is touched.
 */
export function admitContextCollectionWrite(
    schema: string, payload: unknown, governance: ContextWriteGovernance): AdmittedContextDocumentWrite {
  const registered = registeredSchemas.get(schema);
  if (!registered) {
    throw new Error(`Context collection write refused: schema ${JSON.stringify(schema)} is not registered.`);
  }
  return registered(payload, governance);
}
