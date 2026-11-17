/** Public deployment marker, never an authentication secret. Set only as part of
 * an offline, backed-up account reset. Empty preserves the current deployment. */
export function getAccountDataGeneration(): string {
  return String(process.env.ACCOUNT_DATA_GENERATION || '').trim();
}

export function assertAccountDataGenerationConfiguration(): void {
  const generation = getAccountDataGeneration();
  if (!generation) return;
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(generation)) throw new Error('Invalid ACCOUNT_DATA_GENERATION');
  if (process.env.INSTALL_AUTH_MODE === 'legacy-migration' || process.env.HTTP_INSTALL_SECRET_REQUIRED !== '1') {
    throw new Error('Account reset requires strict HTTP and socket installation authentication');
  }
}

export function acceptsAccountDataGeneration(value: unknown): boolean {
  const required = getAccountDataGeneration();
  return !required || value === required;
}

/** Never publish a reset marker before the matching transaction committed in this database. */
export async function assertAccountDataGenerationReceipt(readReceipt: () => Promise<unknown>): Promise<void> {
  const generation = getAccountDataGeneration();
  if (!generation) return;
  if (await readReceipt() !== generation) throw new Error('Account reset receipt does not match configured generation');
}
