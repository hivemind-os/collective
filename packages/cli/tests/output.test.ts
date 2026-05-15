import { afterEach, describe, expect, it, vi } from 'vitest';

import { error, formatTable, info, success } from '../src/utils/output.js';

const originalNoColor = process.env.NO_COLOR;
const originalIsTTY = process.stdout.isTTY;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: originalIsTTY,
  });
});

describe('output helpers', () => {
  it('table formatter produces aligned output', () => {
    const rendered = formatTable(
      ['Name', 'Price'],
      [
        ['echo', '1'],
        ['longer-name', '200'],
      ],
    );

    expect(rendered).toBe(['Name        | Price', '------------+------', 'echo        | 1    ', 'longer-name | 200  '].join('\n'));
  });

  it('success, error, and info produce the correct prefixes', () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    success('done');
    info('hello');
    error('bad');

    expect(logSpy).toHaveBeenNthCalledWith(1, '\u2713 done');
    expect(logSpy).toHaveBeenNthCalledWith(2, '\u2139 hello');
    expect(errorSpy).toHaveBeenCalledWith('\u2717 bad');
  });

  it('NO_COLOR disables ANSI codes', () => {
    process.env.NO_COLOR = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    success('plain');

    expect(logSpy).toHaveBeenCalledWith('\u2713 plain');
  });
});
