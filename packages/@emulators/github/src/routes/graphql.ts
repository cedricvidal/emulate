import { buildSchema, graphql, GraphQLError } from "graphql";
import type { Context, RouteContext } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { typeDefs } from "../graphql/schema.js";
import { createRootValue, type GraphQLContext } from "../graphql/resolvers.js";

const schema = buildSchema(typeDefs);

interface GraphQLRequestBody {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/**
 * Logs validation failures with the offending field path. A missing field is
 * the usual reason a gh or MCP command breaks against the emulator, and the
 * path is what makes it fixable in one step.
 */
function logErrors(errors: readonly GraphQLError[], operationName: string | undefined): void {
  for (const error of errors) {
    const path = error.path?.join(".") ?? error.nodes?.[0]?.loc?.startToken.value ?? "unknown";
    console.error(`[github graphql] ${operationName ?? "anonymous"}: ${error.message} (at ${path})`);
  }
}

export function graphqlRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const gh = getGitHubStore(store);

  const handler = async (c: Context) => {
    let body: GraphQLRequestBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ errors: [{ message: "Problems parsing JSON" }] }, 400);
    }

    if (!body.query) {
      return c.json({ errors: [{ message: "A query attribute must be specified and must be a string." }] }, 400);
    }

    const graphqlContext: GraphQLContext = {
      gh,
      baseUrl,
      viewerLogin: c.get("authUser")?.login ?? null,
    };

    const result = await graphql({
      schema,
      source: body.query,
      rootValue: createRootValue(graphqlContext),
      variableValues: body.variables,
      operationName: body.operationName,
    });

    if (result.errors?.length) {
      logErrors(result.errors, body.operationName);
    }

    // GitHub answers GraphQL errors with 200 and an errors array, so clients
    // that inspect the body rather than the status keep working.
    return c.json(result as Record<string, unknown>, 200);
  };

  // gh talks to api.github.localhost/graphql; the official MCP server uses
  // /api/graphql on a GHES-style host.
  app.post("/graphql", handler);
  app.post("/api/graphql", handler);
}
