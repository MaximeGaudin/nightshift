export interface CliOptions {
  port: number;
  dir?: string;
  open: boolean;
  agents: boolean;
  help: boolean;
}

export class CliError extends Error {}

export const USAGE = "Usage: nightshift [project-dir] [--port 4545] [--no-open] [--no-agents]";

/** Strict decimal integer 0..65535, otherwise throws `Invalid port: <value>`. */
export function parsePort(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new CliError(`Invalid port: ${value ?? ""}`);
  const n = Number(value);
  if (n > 65535) throw new CliError(`Invalid port: ${value}`);
  return n;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>): CliOptions {
  const opts: CliOptions = { port: env.PORT ? parsePort(env.PORT) : 4545, open: true, agents: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--port" || a === "-p") opts.port = parsePort(argv[++i]);
    else if (a === "--no-open") opts.open = false;
    else if (a === "--no-agents") opts.agents = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("-")) throw new CliError(`Unknown option: ${a}`);
    else opts.dir = a;
  }
  return opts;
}

/** Opens `url` in the default browser. Never throws: a missing opener (Linux without xdg-open) only prints a hint on stderr. */
export function openBrowser(url: string, opener = process.platform === "darwin" ? "open" : "xdg-open"): boolean {
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
    return true;
  } catch (e) {
    console.error(`Could not open the browser (${e instanceof Error ? e.message : String(e)}). Open ${url} yourself.`);
    return false;
  }
}
