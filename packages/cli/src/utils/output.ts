const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m',
} as const;

export function success(message: string): void {
  console.log(formatMessage('\u2713', message, COLORS.green));
}

export function error(message: string): void {
  console.error(formatMessage('\u2717', message, COLORS.red));
}

export function info(message: string): void {
  console.log(formatMessage('\u2139', message, COLORS.blue));
}

export function warn(message: string): void {
  console.warn(formatMessage('\u26A0', message, COLORS.yellow));
}

export function table(headers: string[], rows: string[][]): void {
  console.log(formatTable(headers, rows));
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => {
    const rowWidth = Math.max(...rows.map((row) => (row[index] ?? '').length), 0);
    return Math.max(header.length, rowWidth);
  });

  const renderRow = (row: string[]) => row.map((cell, index) => (cell ?? '').padEnd(widths[index] ?? 0, ' ')).join(' | ');

  return [renderRow(headers), widths.map((width) => '-'.repeat(width)).join('-+-'), ...rows.map(renderRow)].join('\n');
}

function formatMessage(symbol: string, message: string, color: string): string {
  const prefix = shouldUseColor() ? `${color}${symbol}${COLORS.reset}` : symbol;
  return `${prefix} ${message}`;
}

function shouldUseColor(): boolean {
  return !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
}
