import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";

declare const PKG_VERSION: string;
const pkg = { version: PKG_VERSION };

const defaultPort = process.env.EMULATE_PORT ?? process.env.PORT ?? "4000";

const program = new Command();

program
  .name("emulate")
  .description("Local drop-in replacement services for CI and no-network sandboxes")
  .version(pkg.version)
  .addHelpText(
    "after",
    `
Framework adapters:
  Embed emulators in app routes with @emulators/adapter-next or @emulators/adapter-nuxt.
  Docs: https://emulate.dev/docs/nextjs and https://emulate.dev/docs/nuxt

GitHub API coverage:
  Includes repository contents, raw downloads, commit history, commit details, and ref comparisons.
  Serves GraphQL at /graphql and /api/graphql, and REST under /api/v3 for GitHub Enterprise clients.
  Inspect minted installation-token metadata at GET /_emulate/installation-tokens.
  Reset to seed state with POST /_emulate/reset.

GitHub Git transport:
  Repositories are clonable and pushable over Git smart HTTP at /<owner>/<repo>.git.
  Requires git on PATH. Set github.git_dir in the seed, or EMULATE_GIT_DIR, to choose the mirror root.

Using the gh CLI and the GitHub MCP server:
  gh   HTTP_PROXY=http://127.0.0.1:<port> GH_HOST=github.localhost GH_TOKEN=<token> gh issue view 11 -R <owner>/<repo>
  MCP  GITHUB_HOST=http://localhost:<port> GITHUB_PERSONAL_ACCESS_TOKEN=<token>
  Only HTTP_PROXY is needed, so npm and other HTTPS traffic is unaffected.

Importing a real repository:
  scripts/import-github <owner>/<repo> --as <owner>/<repo> --out <dir>
  Imports full history plus issues, pull requests, comments, and labels.

Linear API coverage:
  Issue queries and mutations include numeric priority and derived priorityLabel fields.

Vercel API coverage:
  GET /v7/deployments lists deployments by commit SHA across a team's projects, with cursor pagination.

Webhook signatures:
  Stripe webhook secrets produce a Stripe-Signature header for raw-body verification.
`,
  );

program
  .command("start", { isDefault: true })
  .description("Start the emulator server")
  .option("-p, --port <port>", "Base port", defaultPort)
  .option("-s, --service <services>", "Comma-separated services to enable")
  .option("--seed <file>", "Path to seed config file")
  .option("--base-url <url>", "Override advertised base URL (supports {service} template)")
  .option("--portless", "Serve over HTTPS via portless (auto-registers aliases)")
  .option(
    "--generated-secrets-file <path>",
    "Write service-generated secrets to a new owner-only JSON file (Linux requires setfacl and getfacl)",
  )
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${opts.port}`);
      process.exit(1);
    }
    const options = {
      port,
      service: opts.service,
      seed: opts.seed,
      baseUrl: opts.baseUrl,
      portless: opts.portless,
      generatedSecretsFile: opts.generatedSecretsFile,
    };
    if (!opts.generatedSecretsFile) {
      await startCommand(options);
      return;
    }
    try {
      await startCommand(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Generate a starter config file")
  .option("-s, --service <service>", "Service to generate config for", "all")
  .action((opts) => {
    initCommand({ service: opts.service });
  });

program
  .command("list")
  .alias("list-services")
  .description("List available services")
  .action(() => {
    listCommand();
  });

program.parse();
