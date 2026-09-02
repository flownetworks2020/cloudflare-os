import { describe, expect, it } from "vitest";
import { MANAGED_GADGET_CONTRACT, buildManagedWorkspacePrompt } from "../src/overseer.js";

// A managed workspace agent has no tools: it sees one prompt plus the workspace files and returns
// a finished edit. So every platform convention it cannot read off the files has to be stated in
// the prompt, and each assertion below stands for a build that failed in production because the
// prompt omitted that fact. These are pinned as substrings deliberately -- the wording may be
// reworded, but the identifier, filename, or error string an agent has to act on may not vanish.

describe("MANAGED_GADGET_CONTRACT", () => {
  it("states the client.js / server.js file model and that there is no index.html", () => {
    expect(MANAGED_GADGET_CONTRACT).toContain("client.js");
    expect(MANAGED_GADGET_CONTRACT).toContain("server.js");
    expect(MANAGED_GADGET_CONTRACT).toContain("document.body");
    expect(MANAGED_GADGET_CONTRACT).toContain("There is no index.html");
    // The symptom, so an agent seeing it recognizes the cause rather than iterating.
    expect(MANAGED_GADGET_CONTRACT).toContain("No gadget UI yet");
    expect(MANAGED_GADGET_CONTRACT).toContain("this.ctx.storage");
  });

  it("requires the exact Gadget export name and names the error the runtime substitutes", () => {
    expect(MANAGED_GADGET_CONTRACT).toContain('import { DurableObject } from "cloudflare:workers"');
    expect(MANAGED_GADGET_CONTRACT).toContain("class Gadget extends DurableObject");
    expect(MANAGED_GADGET_CONTRACT).toContain("internal error; reference =");
  });

  it("describes the client stub as a module-scope binding, not window.gadget", () => {
    expect(MANAGED_GADGET_CONTRACT).toContain("module-scope");
    expect(MANAGED_GADGET_CONTRACT).toContain("window.gadget is undefined");
    // Probing an RPC proxy proves nothing; the contract must say to call and catch instead.
    expect(MANAGED_GADGET_CONTRACT).toContain("typeof gadget.someMethod");
    expect(MANAGED_GADGET_CONTRACT).toContain("rejected promise");
  });

  it("says a gatekeeper binding is the opened session and demands a blocked state when absent", () => {
    expect(MANAGED_GADGET_CONTRACT).toContain("this.env.NAME.someMethod()");
    expect(MANAGED_GADGET_CONTRACT).toContain("do not call openSession() on it");
    expect(MANAGED_GADGET_CONTRACT).toContain("blocked state");
  });

  it("stays bounded and free of workspace-specific detail", () => {
    // The contract rides on every managed turn, so it is budgeted rather than open-ended.
    expect(MANAGED_GADGET_CONTRACT.length).toBeLessThan(3000);
    for (const specific of ["Workroom", "Concourse Home", "CONCOURSE_HOME", "Flow City"]) {
      expect(MANAGED_GADGET_CONTRACT).not.toContain(specific);
    }
  });
});

describe("buildManagedWorkspacePrompt", () => {
  it("carries the contract and the transcript into the managed turn's prompt", () => {
    const prompt = buildManagedWorkspacePrompt("[USER] build me a tracker");
    expect(prompt).toContain(MANAGED_GADGET_CONTRACT);
    expect(prompt).toContain("[USER] build me a tracker");
    // The contract is instruction, so it must precede the transcript it applies to.
    expect(prompt.indexOf(MANAGED_GADGET_CONTRACT))
      .toBeLessThan(prompt.indexOf("[USER] build me a tracker"));
  });

  it("keeps the pre-existing workspace instructions", () => {
    const prompt = buildManagedWorkspacePrompt("");
    expect(prompt).toContain("You are the selected coding agent for a Concourse gadget workspace.");
    expect(prompt).toContain("Do not merely describe edits");
  });
});
