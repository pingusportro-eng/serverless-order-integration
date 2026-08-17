export type SamLocalEnvironment = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface CreateSamLocalEnvironmentFileOptions {
  readonly environmentPath?: string;
  readonly sourceFixturePath?: string;
  readonly outputPath?: string;
}

export function buildSamLocalEnvironment(
  fixture: SamLocalEnvironment,
  localEnvironment: Readonly<Record<string, string>>,
): SamLocalEnvironment;

export function createSamLocalEnvironmentFile(
  options?: CreateSamLocalEnvironmentFileOptions,
): Promise<string>;
