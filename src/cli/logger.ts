import process from "node:process";

export interface Colors {
  reset: string;
  red: string;
  green: string;
  yellow: string;
  cyan: string;
  dim: string;
  bold: string;
}

const NO_COLORS: Colors = {
  reset: "",
  red: "",
  green: "",
  yellow: "",
  cyan: "",
  dim: "",
  bold: "",
};

export function createColors(enabled: boolean): Colors {
  if (!enabled) return NO_COLORS;
  return {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
  };
}

const colors = createColors(process.stdout.isTTY === true);

// oxlint-disable-next-line no-console -- CLI output
const log = console.log;
// oxlint-disable-next-line no-console -- CLI output
const logError = console.error;

export const logger = {
  info(msg: string): void {
    log(`${colors.cyan}info${colors.reset} ${msg}`);
  },
  success(msg: string): void {
    log(`${colors.green}done${colors.reset} ${msg}`);
  },
  warn(msg: string): void {
    logError(`${colors.yellow}warn${colors.reset} ${msg}`);
  },
  error(msg: string): void {
    logError(`${colors.red}error${colors.reset} ${msg}`);
  },
  dim(msg: string): void {
    log(`${colors.dim}${msg}${colors.reset}`);
  },
};
