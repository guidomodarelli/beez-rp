/**
 * Tests GitHub adapter outcomes and duplicate-mutation prevention at the subprocess boundary.
 * @module tests/create-version/github-workflow
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubWorkflowClient } from "../../src/create-version/github-workflow.js";

afterEach(() => vi.unstubAllEnvs());

/**
 * Simulates external CLI responses while retaining a publication request counter.
 * @param {{ runStatus?: string, conclusion?: string | null, dispatchExit?: number, lookupExit?: number, acceptedAfterDispatch?: boolean, secrets?: string[], variables?: string[], inOrganization?: boolean, organizationSecrets?: string[], organizationVariables?: string[], organizationExit?: number, diagnostic?: string }} [options] - External service outcomes.
 * @returns {{ client: import("../../src/create-version/github-workflow.js").GithubWorkflowClient, submissions: () => number, organizationLookups: () => number }} Real adapter and observed requests.
 */
function createGithubFixture({ runStatus, conclusion = null, dispatchExit = 0, lookupExit = 0, acceptedAfterDispatch = false, secrets = [], variables = [], inOrganization = false, organizationSecrets = [], organizationVariables = [], organizationExit = 0, diagnostic = "Upstream unavailable" } = {}) {
  let submissions = 0;
  let organizationLookups = 0;
  const releaseSha = "a".repeat(40);
  /** @type {typeof import("../../src/create-version/process.js").runCaptured} */
  const capture = async (command, args) => {
    if (command === "git") return { status: 0, stdout: "git@github.com:fixture/app.git", stderr: "" };
    if (args[0] === "repo") return { status: 0, stdout: JSON.stringify({ defaultBranchRef: { name: "main" }, isInOrganization: inOrganization }), stderr: "" };
    if (args[0] === "secret" || args[0] === "variable") return { status: 0, stdout: JSON.stringify((args[0] === "secret" ? secrets : variables).map((name) => ({ name }))), stderr: "" };
    if (args[0] === "api") {
      organizationLookups += 1;
      const shared = args.some((arg) => arg.includes("organization-secrets")) ? organizationSecrets : organizationVariables;
      // gh applies --jq per page and prints one name per line, with CRLF on Windows.
      return { status: organizationExit, stdout: organizationExit === 0 ? shared.map((name) => `${name}\r\n`).join("") : "", stderr: diagnostic };
    }
    if (args[0] === "run") return { status: lookupExit, stdout: JSON.stringify(runStatus || (acceptedAfterDispatch && submissions > 0) ? [{ displayTitle: `beez-rp release v1.2.4 ${releaseSha}`, status: runStatus ?? "queued", conclusion, url: "https://github.com/fixture/app/actions/runs/1" }] : []), stderr: diagnostic };
    if (args[0] === "workflow") { submissions += 1; return { status: dispatchExit, stdout: "", stderr: diagnostic }; }
    return { status: 0, stdout: "gh", stderr: "" };
  };
  return { client: createGithubWorkflowClient("fixture", capture), submissions: () => submissions, organizationLookups: () => organizationLookups };
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

  it("should accept a required secret shared by the organization when the repository does not define it", async () => {
    // Arrange
    const { client, organizationLookups } = createGithubFixture({ inOrganization: true, secrets: ["OTHER_SECRET"], organizationSecrets: ["NPM_TOKEN"] });
    // Act
    const result = client.preflight("release.yml", ["NPM_TOKEN"], []);
    // Assert
    await expect(result).resolves.toBeUndefined();
    expect(organizationLookups()).toBe(1);
  });

  it("should accept a required variable shared by the organization when the repository does not define it", async () => {
    // Arrange
    const { client } = createGithubFixture({ inOrganization: true, organizationSecrets: ["DEPLOY_URL"], organizationVariables: ["DEPLOY_URL"] });
    // Act
    const result = client.preflight("release.yml", [], ["DEPLOY_URL"]);
    // Assert
    await expect(result).resolves.toBeUndefined();
  });

  it("should report only the names missing at both repository and organization level", async () => {
    // Arrange
    const { client, submissions } = createGithubFixture({ inOrganization: true, secrets: ["VERCEL_TOKEN"], organizationSecrets: ["VERCEL_ORG_ID"] });
    // Act
    const result = client.preflight("release.yml", ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"], []);
    // Assert
    await expect(result).rejects.toMatchObject({ code: "ci-preflight-failed", message: expect.stringMatching(/: VERCEL_PROJECT_ID\.$/u), hint: expect.stringContaining("organización") });
    expect(submissions()).toBe(0);
  });

  it("should block with an actionable redacted error when organization bindings cannot be listed", async () => {
    // Arrange
    vi.stubEnv("GH_TOKEN", "fixture-sensitive-token");
    const { client } = createGithubFixture({ inOrganization: true, organizationExit: 1, diagnostic: "HTTP 403 for fixture-sensitive-token" });
    // Act
    const result = client.preflight("release.yml", ["NPM_TOKEN"], []);
    // Assert
    await expect(result).rejects.toMatchObject({
      code: "ci-preflight-failed",
      message: expect.stringMatching(/NPM_TOKEN.*organización.*HTTP 403 for \[redactado\]/u),
      hint: expect.stringContaining("gh secret set NPM_TOKEN --repo fixture/app"),
    });
  });

  it("should skip organization lookups when the repository already defines every required binding", async () => {
    // Arrange
    const { client, organizationLookups } = createGithubFixture({ inOrganization: true, secrets: ["NPM_TOKEN"] });
    // Act
    await client.preflight("release.yml", ["NPM_TOKEN"], []);
    // Assert
    expect(organizationLookups()).toBe(0);
  });

  it("should not query organization bindings for a personal repository", async () => {
    // Arrange
    const { client, organizationLookups } = createGithubFixture({ organizationSecrets: ["NPM_TOKEN"] });
    // Act
    const result = client.preflight("release.yml", ["NPM_TOKEN"], []);
    // Assert
    await expect(result).rejects.toMatchObject({ code: "ci-preflight-failed", message: expect.stringContaining("NPM_TOKEN"), hint: expect.not.stringContaining("organización") });
    expect(organizationLookups()).toBe(0);
  });
});
