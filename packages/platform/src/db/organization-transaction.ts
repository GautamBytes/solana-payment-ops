import postgres from "postgres";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const actorPattern = /^[\x21-\x7e]{1,128}$/;

export type OrganizationTransaction = postgres.TransactionSql;

export interface OrganizationTransactionContext {
  readonly organizationId: string;
  readonly actorId: string;
}

export class OrganizationTransactionError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("Organization transaction failed");
    this.name = "OrganizationTransactionError";
    this.code = code;
  }
}

export class OrganizationDatabase {
  readonly #sql: postgres.Sql;

  public constructor(
    databaseUrl: string,
    options: { readonly max?: number } = {},
  ) {
    this.#sql = postgres(databaseUrl, {
      max: options.max ?? 10,
      onnotice: () => undefined,
    });
  }

  public async transaction<T>(
    context: OrganizationTransactionContext,
    operation: (transaction: OrganizationTransaction) => Promise<T>,
  ): Promise<T> {
    validateContext(context);
    const result = await this.#sql.begin(async (transaction) => {
      await transaction`
        SELECT set_config('payops.organization_id', ${context.organizationId}, true),
          set_config('payops.actor_id', ${context.actorId}, true)
      `;
      return { value: await operation(transaction) };
    });
    return result.value;
  }

  public async close(): Promise<void> {
    await this.#sql.end();
  }

  public async healthCheck(): Promise<void> {
    await this.#sql`SELECT 1`;
  }
}

function validateContext(context: OrganizationTransactionContext): void {
  if (
    !canonicalUuidPattern.test(context.organizationId) ||
    !actorPattern.test(context.actorId)
  ) {
    throw new OrganizationTransactionError("invalid_organization_context");
  }
}
