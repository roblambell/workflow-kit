const isTTY = process.stdout.isTTY ?? false;
const isCI = !!process.env.CI;
const useColor = isTTY && !isCI;

export const RED = useColor ? "\x1b[0;31m" : "";
export const GREEN = useColor ? "\x1b[0;32m" : "";
export const YELLOW = useColor ? "\x1b[0;33m" : "";
export const BLUE = useColor ? "\x1b[0;34m" : "";
export const CYAN = useColor ? "\x1b[0;36m" : "";
export const BOLD = useColor ? "\x1b[1m" : "";
export const DIM = useColor ? "\x1b[2m" : "";
export const RESET = useColor ? "\x1b[0m" : "";

export function die(message: string): never {
  console.error(`${RED}Error:${RESET} ${message}`);
  process.exit(1);
}

export function warn(message: string): void {
  console.error(`${YELLOW}Warning:${RESET} ${message}`);
}

export function info(message: string): void {
  console.log(`${BLUE}>>>${RESET} ${message}`);
}
