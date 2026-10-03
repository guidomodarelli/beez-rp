/**
 * Tests GitHub adapter outcomes and duplicate-mutation prevention at the subprocess boundary.
 * @module tests/create-version/github-workflow
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubWorkflowClient } from "../../src/create-version/github-workflow.js";

afterEach(() => vi.unstubAllEnvs());

/**
 * Simulates external CLI responses while retaining a publication request counter.
 * @param {{ runStatus?: string, conclusion?: string | null, dispatchExit?: number, lookupExit?: number, acceptedAfterDispatch?: boolean, secrets?: string[], diagnostic?: string }} [options] - External service outcomes.
 * @returns {{ client: import("../../src/create-version/github-workflow.js").GithubWorkflowClient, submissions: () => number }} Real adapter and observed mutations.
 */
function createGithubFixture({ runStatus, conclusion = null, dispatchExit = 0, lookupExit = 0, acceptedAfterDispatch = false, secrets = [], diagnostic = "Upstream unavailable" } = {}) {
  let submissions = 0;
  const releaseSha = "a".repeat(40);
  /** @type {typeof import("../../src/create-version/process.js").runCaptured} */
  const capture = async (command, args) => {
    if (command === "git") return { status: 0, stdout: "git@github.com:fixture/app.git", stderr: "" };
    if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }), stderr: "" };
    if (args[0] === "secret" || args[0] === "variable") return { status: 0, stdout: JSON.stringify(secrets.map((name) => ({ name }))), stderr: "" };
    if (args[0] === "run") return { status: lookupExit, stdout: JSON.stringify(runStatus || (acceptedAfterDispatch && submissions > 0) ? [{ displayTitle: `beez-rp release v1.2.4 ${releaseSha}`, status: runStatus ?? "queued", conclusion, url: "https://github.com/fixture/app/actions/runs/1" }] : []), stderr: diagnostic };
    if (args[0] === "workflow") { submissions += 1; return { status: dispatchExit, stdout: "", stderr: diagnostic }; }
    return { status: 0, stdout: "gh", stderr: "" };
  };
  return { client: createGithubWorkflowClient("fixture", capture), submissions: () => submissions };
}

describe("GitHub workflow acceptance", () => {
  it("should preserve the current release without another mutation when existing runs cannot be queried", async () => {
    // Arrange
    const { client, submissions } = createGithubFixture({ lookupExit: 1 });
    await client.preflight("release.yml", [], []);
    // Act and Assert
    await expect(client.dispatch("release.yml", { version: "1.2.4", tag: "v1.2.4", sha: "a".repeat(40) }, "pnpm cv --retry-ci v1.2.4")).rejects.toMatchObject({ code: "ci-run-lookup-failed", hint: expect.stringContaining("--retry-ci v1.2.4") });
    expect(submissions()).toBe(0);
  });

  it.each(["queued", "in_progress", "completed"])("should reuse an accepted run without another dispatch when status is %s", async (runStatus) => {
    // Arrange
    const { client, submissions } = createGithubFixture({ runStatus, conclusion: "success" });
    await client.preflight("release.yml", [], []);
    // Act
    const result = await client.dispatch("release.yml", { version: "1.2.4", tag: "v1.2.4", sha: "a".repeat(40) }, "pnpm cv --retry-ci v1.2.4");
    // Assert
    expect(result).toEqual({ status: "existing", url: "https://github.com/fixture/app/actions/runs/1" });
    expect(submissions()).toBe(0);
  });

  it("should reconcile an accepted run when the dispatch response fails without resubmitting", async () => {
    // Arrange
    const { client, submissions } = createGithubFixture({ dispatchExit: 1, acceptedAfterDispatch: true });
    await client.preflight("release.yml", [], []);
    // Act
    const result = await client.dispatch("release.yml", { version: "1.2.4", tag: "v1.2.4", sha: "a".repeat(40) }, "pnpm cv --retry-ci v1.2.4");
    // Assert
    expect(result.status).toBe("existing");
    expect(submissions()).toBe(1);
  });

  it("should retain the exact retry identity and redact credentials when acceptance cannot be confirmed", async () => {
    // Arrange
    vi.stubEnv("GH_TOKEN", "fixture-sensitive-token");
    const { client, submissions } = createGithubFixture({ dispatchExit: 1, diagnostic: "failed with fixture-sensitive-token" });
    await client.preflight("release.yml", [], []);
    // Act
    const result = client.dispatch("release.yml", { version: "1.2.4", tag: "v1.2.4", sha: "a".repeat(40) }, "pnpm cv --retry-ci v1.2.4");
    // Assert
    await expect(result).rejects.toMatchObject({ code: "ci-dispatch-unconfirmed", hint: expect.stringContaining("--retry-ci v1.2.4"), message: expect.stringContaining("[redactado]") });
    expect(submissions()).toBe(1);
  });

  it("should allow an explicit retry when the previous run ended in failure", async () => {
    // Arrange
    const { client, submissions } = createGithubFixture({ runStatus: "completed", conclusion: "failure" });
    await client.preflight("release.yml", [], []);
    // Act
    const result = await client.dispatch("release.yml", { version: "1.2.4", tag: "v1.2.4", sha: "a".repeat(40) }, "pnpm cv --retry-ci v1.2.4");
    // Assert
    expect(result.status).toBe("submitted");
    expect(submissions()).toBe(1);
  });

  it("should block before any dispatch when a required worker secret is missing", async () => {
    // Arrange
    const { client, submissions } = createGithubFixture({ secrets: ["OTHER_SECRET"] });
    // Act and Assert
    await expect(client.preflight("release.yml", ["NPM_TOKEN"], [])).rejects.toMatchObject({ code: "ci-preflight-failed", message: expect.stringContaining("NPM_TOKEN") });
    expect(submissions()).toBe(0);
  });
});
