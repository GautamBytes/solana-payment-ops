import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "../audit/audit-store.js";
import type { OrganizationDatabase } from "../db/organization-transaction.js";
import {
  CustomerError,
  type CreateCustomerInput,
  type CustomerRecord,
} from "./types.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class CustomerStore {
  readonly #database: OrganizationDatabase;

  public constructor(database: OrganizationDatabase) {
    this.#database = database;
  }

  public async create(input: CreateCustomerInput): Promise<CustomerRecord> {
    const normalized = normalizeCustomer(input);
    const id = randomUUID();
    try {
      return await this.#database.transaction(
        { organizationId: input.organizationId, actorId: input.actorId },
        async (transaction) => {
          const rows = await transaction<CustomerRow[]>`
            INSERT INTO customers (
              id, organization_id, external_id, display_name, email,
              metadata, created_at, updated_at
            ) VALUES (
              ${id}::uuid, ${input.organizationId}::uuid,
              ${normalized.externalId}, ${normalized.displayName},
              ${normalized.email}, ${transaction.json(normalized.metadata)},
              ${input.now.toISOString()}, ${input.now.toISOString()}
            )
            RETURNING id::text, organization_id::text, external_id,
              display_name, email, metadata, created_at, updated_at
          `;
          if (input.auditRequestId !== undefined) {
            await appendAuditEvent(transaction, {
              organizationId: input.organizationId,
              actorKind: input.actorKind,
              actorId: input.actorId,
              action: "customer.create",
              objectKind: "customer",
              objectId: id,
              requestId: input.auditRequestId,
              outcome: "succeeded",
              reasonCode: "created",
              occurredAt: input.now,
            });
          }
          const customer = toCustomer(rows[0]!);
          await input.idempotency?.complete(transaction, 201, customer);
          return customer;
        },
      );
    } catch (error) {
      const code = safeOwnCode(error);
      if (code === "23505")
        throw new CustomerError("customer_external_id_conflict");
      if (allowedCustomerCode(code)) throw new CustomerError(code);
      throw new CustomerError("customer_store_unavailable", error);
    }
  }

  public async get(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly customerId: string;
  }): Promise<CustomerRecord | null> {
    if (!uuidPattern.test(input.customerId)) return null;
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (transaction) => {
        const rows = await transaction<CustomerRow[]>`
          SELECT id::text, organization_id::text, external_id, display_name,
            email, metadata, created_at, updated_at
          FROM customers
          WHERE organization_id = ${input.organizationId}::uuid
            AND id = ${input.customerId}::uuid AND disabled_at IS NULL
        `;
        return rows[0] === undefined ? null : toCustomer(rows[0]);
      },
    );
  }

  public async list(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly limit: number;
    readonly after?: { readonly createdAt: string; readonly id: string };
  }): Promise<readonly CustomerRecord[]> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 101
    ) {
      throw new CustomerError("invalid_customer_list");
    }
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (transaction) => {
        const afterCreatedAt = input.after?.createdAt ?? null;
        const afterId = input.after?.id ?? null;
        const rows = await transaction<CustomerRow[]>`
          SELECT id::text, organization_id::text, external_id, display_name,
            email, metadata, created_at, updated_at
          FROM customers
          WHERE organization_id = ${input.organizationId}::uuid
            AND disabled_at IS NULL
            AND (
              ${afterCreatedAt}::timestamptz IS NULL
              OR (created_at, id) < (${afterCreatedAt}::timestamptz, ${afterId}::uuid)
            )
          ORDER BY created_at DESC, id DESC
          LIMIT ${input.limit}
        `;
        return rows.map(toCustomer);
      },
    );
  }
}

interface CustomerRow {
  readonly id: string;
  readonly organization_id: string;
  readonly external_id: string | null;
  readonly display_name: string;
  readonly email: string | null;
  readonly metadata: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function normalizeCustomer(input: CreateCustomerInput): {
  readonly externalId: string | null;
  readonly displayName: string;
  readonly email: string | null;
  readonly metadata: Readonly<Record<string, string>>;
} {
  if (!Number.isFinite(input.now.getTime()))
    throw new CustomerError("invalid_customer");
  const displayName = input.displayName.trim().normalize("NFC");
  if (codePointLength(displayName) < 1 || codePointLength(displayName) > 128) {
    throw new CustomerError("invalid_customer_display_name");
  }
  const externalId = normalizeOptional(
    input.externalId,
    128,
    "invalid_customer_external_id",
  );
  const email = normalizeEmail(input.email);
  const metadata = normalizeMetadata(input.metadata ?? {});
  return { externalId, displayName, email, metadata };
}

function normalizeOptional(
  value: string | null | undefined,
  maximum: number,
  code: string,
): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.normalize("NFC");
  if (
    codePointLength(normalized) < 1 ||
    codePointLength(normalized) > maximum ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  )
    throw new CustomerError(code);
  return normalized;
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim().toLowerCase().normalize("NFC");
  if (normalized.length > 254 || !emailPattern.test(normalized)) {
    throw new CustomerError("invalid_customer_email");
  }
  return normalized;
}

function normalizeMetadata(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  let entries: [string, string][];
  try {
    entries = Object.entries(value);
  } catch {
    throw new CustomerError("invalid_customer_metadata");
  }
  if (entries.length > 20) throw new CustomerError("invalid_customer_metadata");
  const normalized: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [key, entry] of entries) {
    if (
      !/^[\x20-\x7e]{1,64}$/.test(key) ||
      typeof entry !== "string" ||
      codePointLength(entry) > 256
    )
      throw new CustomerError("invalid_customer_metadata");
    normalized[key] = entry.normalize("NFC");
  }
  return Object.freeze(normalized);
}

function toCustomer(row: CustomerRow): CustomerRecord {
  if (
    row.metadata === null ||
    typeof row.metadata !== "object" ||
    Array.isArray(row.metadata)
  ) {
    throw new CustomerError("corrupt_customer");
  }
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.metadata)) {
    if (typeof value !== "string") throw new CustomerError("corrupt_customer");
    metadata[key] = value;
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    externalId: row.external_id,
    displayName: row.display_name,
    email: row.email,
    metadata: Object.freeze(metadata),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function codePointLength(value: string): number {
  return [...value].length;
}

function allowedCustomerCode(code: string | undefined): code is string {
  return code !== undefined && code.startsWith("invalid_customer");
}

function safeOwnCode(error: unknown): string | undefined {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  )
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}
