import type {
  PreviewStripeReconciliationCommand,
  StripeReconciliationPreview,
} from '../../src/application/preview-stripe-reconciliation.js';

export const LOCAL_RECONCILIATION_TABLE: 'serverless-order-integration-local';
export const LOCAL_RECONCILIATION_ENDPOINT: 'http://127.0.0.1:8000';

export interface StripeReconciliationConfiguration {
  readonly apiKey: string;
  readonly expectedStripeAccountId: string;
  readonly timeoutMs: number;
  readonly dynamoDbEndpoint: typeof LOCAL_RECONCILIATION_ENDPOINT;
  readonly tableName: typeof LOCAL_RECONCILIATION_TABLE;
}

export type ParsedStripeReconciliationArguments =
  | { readonly kind: 'help' }
  | {
      readonly kind: 'preview';
      readonly command: PreviewStripeReconciliationCommand;
    };

export interface StripeReconciliationManifest {
  readonly schemaVersion: 1;
  readonly campaignId: string;
  readonly operation: 'STRIPE_RECONCILIATION';
  readonly createdAt: string;
  readonly previewedAt: string;
  readonly targetStripeAccountId: string;
  readonly localTable: {
    readonly endpoint: typeof LOCAL_RECONCILIATION_ENDPOINT;
    readonly tableName: typeof LOCAL_RECONCILIATION_TABLE;
  };
  readonly selection: StripeReconciliationPreview['selection'];
  readonly entries: StripeReconciliationPreview['entries'];
}

export function stripeReconciliationUsage(): string;
export function parseStripeReconciliationArguments(
  arguments_: readonly string[],
): ParsedStripeReconciliationArguments;
export function loadStripeReconciliationConfiguration(input: {
  readonly environmentPath: string;
}): Promise<StripeReconciliationConfiguration>;
export function createStripeReconciliationManifest(input: {
  readonly preview: StripeReconciliationPreview;
  readonly configuration: StripeReconciliationConfiguration;
  readonly now: Date;
  readonly uuid: string;
}): StripeReconciliationManifest;
export function writeStripeReconciliationManifest(input: {
  readonly manifest: StripeReconciliationManifest;
  readonly directory: string;
}): Promise<string>;

export interface RunStripeReconciliationCliInput {
  readonly arguments_: readonly string[];
  readonly projectRoot: string;
  readonly previewCampaign: (input: {
    readonly command: PreviewStripeReconciliationCommand;
    readonly configuration: StripeReconciliationConfiguration;
    readonly now: () => Date;
  }) => Promise<StripeReconciliationPreview>;
  readonly output: { write(value: string): unknown };
  readonly now?: () => Date;
  readonly uuid?: () => string;
}

export function runStripeReconciliationCli(input: RunStripeReconciliationCliInput): Promise<
  | {
      readonly manifest: StripeReconciliationManifest;
      readonly manifestPath: string;
      readonly preview: StripeReconciliationPreview;
    }
  | undefined
>;
