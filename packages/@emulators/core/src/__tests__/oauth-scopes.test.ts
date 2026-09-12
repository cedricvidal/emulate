import { describe, expect, it } from "vitest";
import { createServer } from "../server.js";
import type { ServicePlugin } from "../plugin.js";

const plugin: ServicePlugin = {
  name: "test",
  register(app) {
    app.get("/user", (c) => c.json({ login: c.get("authUser")?.login ?? null }));
  },
};

describe("OAuth scope headers", () => {
  it("sends authenticated token scopes in GitHub's header format", async () => {
    const { app } = createServer(plugin, {
      tokens: {
        "scoped-token": { login: "alice", id: 1, scopes: ["repo", "read:org"] },
      },
    });

    const res = await app.request("/user", {
      headers: { Authorization: "token scoped-token" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-OAuth-Scopes")).toBe("repo, read:org");
    expect(res.headers.get("X-Accepted-OAuth-Scopes")).toBe("");
  });

  it("does not send OAuth scope headers for unauthenticated requests", async () => {
    const { app } = createServer(plugin, {
      tokens: {
        "scoped-token": { login: "alice", id: 1, scopes: ["repo"] },
      },
    });

    const res = await app.request("/user");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-OAuth-Scopes")).toBeNull();
    expect(res.headers.get("X-Accepted-OAuth-Scopes")).toBeNull();
  });

  it("sends an empty OAuth scopes header when the token has no scopes", async () => {
    const { app } = createServer(plugin, {
      tokens: {
        "no-scope-token": { login: "alice", id: 1, scopes: [] },
      },
    });

    const res = await app.request("/user", {
      headers: { Authorization: "Bearer no-scope-token" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-OAuth-Scopes")).toBe("");
    expect(res.headers.get("X-Accepted-OAuth-Scopes")).toBe("");
  });

  it("does not send OAuth scope headers for installation tokens", async () => {
    const { app, tokenMap } = createServer(plugin);
    tokenMap.set("installation-token", {
      login: "acme",
      id: 7,
      scopes: ["contents:write"],
      installation: {
        installationId: 42,
        appId: 9,
        accountId: 7,
        accountType: "Organization",
        permissions: { contents: "write" },
        repositoryIds: [12],
        repositorySelection: "selected",
      },
    });

    const res = await app.request("/user", {
      headers: { Authorization: "Bearer installation-token" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-OAuth-Scopes")).toBeNull();
    expect(res.headers.get("X-Accepted-OAuth-Scopes")).toBeNull();
  });
});
