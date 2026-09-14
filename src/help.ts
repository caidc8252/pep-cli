import {
  DEFAULT_CLIENT_ID,
  DEFAULT_DOCS_URL,
  DEFAULT_ISSUER,
  DEFAULT_RESOURCES,
  claudeSkillsDirectory,
  defaultSkillsDirectory,
} from "./config.js";
import { PASSWORD_VAR, USERNAME_VAR } from "./maven-env.js";

type CommandHelp = {
  summary: string;
  usage: string;
  description: string;
  flags?: string[];
  examples: string[];
};

const groups: Record<string, { summary: string; commands: Record<string, CommandHelp> }> = {
  auth: {
    summary: "Sign in to PEP and manage your local authorization.",
    commands: {
      login: {
        summary: "Sign in to PEP through your browser.",
        usage: "pep auth login [flags]",
        description: `Opens your browser to sign in, then saves tokens in the OS keychain.
Tokens are refreshed automatically when needed by other commands.
Issuer, client ID and resources use this build's defaults for each new login;
overrides apply to this login only and are not reused by the next login.`,
        flags: [
          `--issuer <url>     PEP server for this login (default: ${DEFAULT_ISSUER})`,
          `--client-id <id>   Registered OAuth client (default: ${DEFAULT_CLIENT_ID})`,
          `--resource <uri>   Token audience; repeat for multiple resources (default: ${DEFAULT_RESOURCES.join(", ")})`,
        ],
        examples: ["pep auth login", "pep auth login --issuer http://localhost:3000"],
      },
      status: {
        summary: "Show the current account and authorization status.",
        usage: "pep auth status",
        description: "Shows the issuer, client, account, granted scopes and access-token expiry.\nRequires a saved login and contacts PEP to retrieve account information.",
        examples: ["pep auth status"],
      },
      token: {
        summary: "Print a current access token for scripts and API clients.",
        usage: "pep auth token",
        description: "Requires a saved login. Refreshes the token if needed and writes only the\naccess token to stdout, so another command can capture it.",
        examples: ["pep auth token", "$token = pep auth token  # PowerShell"],
      },
      logout: {
        summary: "Sign out and remove local authorization.",
        usage: "pep auth logout",
        description: "Attempts to revoke the saved authorization on PEP, then removes local tokens\nand login configuration. Local data is removed even if remote revocation fails.",
        examples: ["pep auth logout"],
      },
    },
  },
  skills: {
    summary: "Download and update PEP agent skills.",
    commands: {
      sync: {
        summary: "Fetch the latest agent skills and install them locally.",
        usage: "pep skills sync [flags]",
        description: `Requires a saved PEP login. Downloads skills to:
  ${defaultSkillsDirectory()}
Also links them into ${claudeSkillsDirectory()} for Claude Code,
or copies them if links are unavailable. Only skills managed by pep are updated
or removed; files you added yourself are left alone.`,
        flags: ["--dir <path>   Install only to this directory; skip links into Claude Code"],
        examples: ["pep skills sync", 'pep skills sync --dir "./my-skills"'],
      },
    },
  },
  docs: {
    summary: "Find and read PEP developer documentation.",
    commands: {
      list: {
        summary: "List the documents your account can read.",
        usage: "pep docs list [flags]",
        description: "Requires a saved PEP login. Prints each document's path and description.\nPass a path from this list to pep docs get to read its Markdown content.",
        flags: [`--docs-url <url>   Documentation server; saved for later use (default: ${DEFAULT_DOCS_URL})`],
        examples: ["pep docs list", "pep docs list --docs-url http://localhost:3001"],
      },
      get: {
        summary: "Read a document as Markdown.",
        usage: "pep docs get <path> [flags]",
        description: "Requires a saved PEP login. Use a document path returned by pep docs list.\nWrites the document's Markdown to stdout, ready to pipe or save to a file.",
        flags: [`--docs-url <url>   Documentation server; saved for later use (default: ${DEFAULT_DOCS_URL})`],
        examples: ['pep docs get "<path-from-pep-docs-list>"', 'pep docs get "<path-from-pep-docs-list>" > document.md'],
      },
    },
  },
  nexus: {
    summary: "Configure Maven repository access for the Newland Android SDK.",
    commands: {
      setup: {
        summary: "Create and save your organisation's Maven credentials.",
        usage: "pep nexus setup",
        description: `Requires a saved PEP login and Maven access in your organisation's contract.
Saves ${USERNAME_VAR} and ${PASSWORD_VAR} to the Windows user
environment or your macOS shell profile. Open a new terminal or restart your IDE
after setup. The command never prints the username or password.

PEP creates one credential per organisation and does not store its password.
An existing credential cannot be retrieved again; reuse your saved configuration
or contact an operator to reset it in Nexus.`,
        examples: ["pep nexus setup"],
      },
    },
  },
};

/** Help is resolved before initializing authentication, reading credentials or making requests. */
export function usage(version: string, path: readonly string[] = []): string {
  const [groupName, commandName] = path;
  if (!groupName) {
    return `PEP CLI ${version}
Sign in to PEP, read developer documentation and configure development tools.

USAGE
  pep <command> <subcommand> [flags]

COMMANDS
${Object.entries(groups).map(([name, group]) => `  ${name.padEnd(10)}${group.summary}`).join("\n")}

FLAGS
  -h, --help      Show help for a command
  -v, --version   Show the CLI version

EXAMPLES
  pep auth login
  pep docs list
  pep nexus setup --help

LEARN MORE
  Use pep <command> --help or pep <command> <subcommand> --help.
  You can also use pep help <command> <subcommand>.
  pep-cli is an alias for pep.`;
  }
  if (!Object.hasOwn(groups, groupName)) throw new Error(`Unknown command: ${groupName}. Run pep --help.`);
  const group = groups[groupName];
  if (!commandName) {
    return `${group.summary}

USAGE
  pep ${groupName} <command> [flags]

COMMANDS
${Object.entries(group.commands).map(([name, command]) => `  ${name.padEnd(10)}${command.summary}`).join("\n")}

FLAGS
  -h, --help   Show help for this command

LEARN MORE
  Use pep ${groupName} <command> --help for details and examples.`;
  }
  if (path.length > 2 || !Object.hasOwn(group.commands, commandName)) {
    throw new Error(`Unknown ${groupName} command: ${path.slice(1).join(" ")}. Run pep ${groupName} --help.`);
  }
  const command = group.commands[commandName];
  return `${command.summary}

${command.description}

USAGE
  ${command.usage}

FLAGS
${[...(command.flags ?? []), "-h, --help         Show help for this command"].map((flag) => `  ${flag}`).join("\n")}

EXAMPLES
${command.examples.map((example) => `  ${example}`).join("\n")}`;
}
