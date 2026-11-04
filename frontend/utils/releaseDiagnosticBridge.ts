type Level = 'info' | 'warning' | 'error';
type Collector = (event: string, level: Level, payload: Record<string, unknown>) => void;
let collector: Collector | null = null;
export function setReleaseDiagnosticCollector(next: Collector | null): void { collector = next; }
/** No native/network imports: callers and their tests remain independent of the uploader. */
export function recordReleaseDiagnostic(event: string, level: Level = 'info', payload: Record<string, unknown> = {}): void {
  try { collector?.(event, level, payload); } catch {}
}
