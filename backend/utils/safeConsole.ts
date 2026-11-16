import { redactLogValue } from './redactLog';
for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
  const write = console[level].bind(console);
  console[level] = (...args: unknown[]) => write(...args.map(value => redactLogValue(value)));
}
