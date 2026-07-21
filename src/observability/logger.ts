export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  readonly requestId: string;
  readonly correlationId?: string;
}

export interface SafeLogFields {
  readonly operation?: string;
  readonly route?: string;
  readonly httpMethod?: string;
  readonly status?: string;
  readonly statusCode?: number;
  readonly orderId?: string;
  readonly merchantId?: string;
  readonly providerCode?: string;
  readonly eventId?: string;
  readonly errorCode?: string;
  readonly durationMs?: number;
  readonly attempt?: number;
}

export interface LogEntry extends LogContext, SafeLogFields {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
}

export type LogSink = (serializedEntry: string) => void;

export interface LoggerOptions {
  readonly now?: () => Date;
  readonly sink?: LogSink;
}

export interface Logger {
  write(level: LogLevel, event: string, fields?: SafeLogFields): void;
}

const SAFE_FIELD_NAMES: ReadonlySet<keyof SafeLogFields> = new Set([
  'operation',
  'route',
  'httpMethod',
  'status',
  'statusCode',
  'orderId',
  'merchantId',
  'providerCode',
  'eventId',
  'errorCode',
  'durationMs',
  'attempt',
]);

const LOG_EVENT_PATTERN = /^[a-z][a-z0-9_.]*$/;

function selectSafeFields(fields: SafeLogFields): SafeLogFields {
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([name, value]) => SAFE_FIELD_NAMES.has(name as keyof SafeLogFields) && value !== undefined,
    ),
  );
}

export function createLogger(context: LogContext, options: LoggerOptions = {}): Logger {
  const now = options.now ?? (() => new Date());
  const sink =
    options.sink ??
    ((serializedEntry: string) => {
      console.log(serializedEntry);
    });

  return {
    write(level, event, fields = {}) {
      if (!LOG_EVENT_PATTERN.test(event)) {
        throw new TypeError('Log event names must be stable dot-separated identifiers.');
      }

      const entry: LogEntry = {
        timestamp: now().toISOString(),
        level,
        event,
        requestId: context.requestId,
        ...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
        ...selectSafeFields(fields),
      };

      sink(JSON.stringify(entry));
    },
  };
}
