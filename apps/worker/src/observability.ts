export type LogFields = Readonly<Record<string, string | number | boolean>>;

export type OperationalEvent =
  | "worker_instance_started"
  | "worker_job_started"
  | "worker_job_completed"
  | "worker_job_failed"
  | "worker_heartbeat_failed"
  | "worker_instance_stopped";

export interface OperationalLogger {
  info(event: OperationalEvent, fields?: LogFields): void;
  warn(event: OperationalEvent, fields?: LogFields): void;
  error(event: OperationalEvent, fields?: LogFields): void;
}

const safeFieldNames = new Set([
  "instanceId",
  "buildRevision",
  "job",
  "operationId",
  "failureClass",
]);

export function serializeOperationalEvent(
  level: "info" | "warn" | "error",
  event: OperationalEvent,
  fields: LogFields = {},
  now: Date = new Date(),
): string {
  const safeFields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!safeFieldNames.has(key)) continue;
    if (typeof value === "string" && value.length <= 128) {
      safeFields[key] = value;
    } else if (typeof value === "boolean") {
      safeFields[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      safeFields[key] = value;
    }
  }
  return JSON.stringify({
    timestamp: now.toISOString(),
    level,
    service: "worker",
    event,
    ...safeFields,
  });
}

export function jsonConsoleLogger(): OperationalLogger {
  const write = (
    level: "info" | "warn" | "error",
    event: OperationalEvent,
    fields: LogFields = {},
  ) => {
    process.stdout.write(
      `${serializeOperationalEvent(level, event, fields)}\n`,
    );
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
