import type {
  AddProviderInput,
  AddWatchTargetInput,
  CompleteSyncRunInput,
  FinalityCandidate,
  IngestionStore,
  ProviderRecord,
  RecordFinalityObservationInput,
  RecordFinalityObservationResult,
  RecordPageInput,
  RecordRepresentationInput,
  RecordRepresentationResult,
  RecordRetryInput,
  StartSyncRunInput,
  SyncLock,
  WatchTarget,
} from "../../src/index.js";

export class MemoryStore implements IngestionStore {
  public provider: ProviderRecord = {
    id: "primary",
    cluster: "mainnet-beta",
    endpointEnv: "SOLANA_RPC_URL",
    endpointLabel: "rpc.invalid",
  };
  public watchTarget: WatchTarget = {
    id: "watch-1",
    providerId: "primary",
    cluster: "mainnet-beta",
    address: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
    cutoverSlot: 1n,
    cutoverSignature: null,
    overlapSlots: 150n,
    committedHeadSlot: null,
    committedHeadSignature: null,
    coverage: "complete",
  };
  public busy = false;
  public failNextRecordPage = false;
  public failNextFinalRepresentation = false;
  public released = 0;
  public readonly runs: StartSyncRunInput[] = [];
  public readonly pages: RecordPageInput[] = [];
  public readonly representations: RecordRepresentationInput[] = [];
  public readonly retries: RecordRetryInput[] = [];
  public readonly resolvedRetries: Array<{
    readonly operation: "page" | "transaction" | "storage";
    readonly signature: string | null;
  }> = [];
  public readonly completions: CompleteSyncRunInput[] = [];
  public finalityCandidates: readonly FinalityCandidate[] = [];
  public readonly finalityObservations: RecordFinalityObservationInput[] = [];
  public signatureInspection: unknown | null = null;
  public lastInspectionOptions: { readonly includeRaw?: boolean } | undefined;
  readonly #signatures = new Set<string>();
  readonly #events = new Set<string>();

  public async tryAcquireSyncLock(): Promise<SyncLock | null> {
    if (this.busy) {
      return null;
    }
    return {
      release: async () => {
        this.released += 1;
      },
    };
  }

  public async getProvider(providerId: string): Promise<ProviderRecord | null> {
    return providerId === this.provider.id ? this.provider : null;
  }

  public async addProvider(input: AddProviderInput): Promise<ProviderRecord> {
    this.provider = input;
    return this.provider;
  }

  public async getWatchTarget(
    watchTargetId: string,
  ): Promise<WatchTarget | null> {
    return watchTargetId === this.watchTarget.id ? this.watchTarget : null;
  }

  public async addWatchTarget(
    input: AddWatchTargetInput,
  ): Promise<WatchTarget> {
    this.watchTarget = {
      ...input,
      committedHeadSlot: input.cutoverSlot,
      committedHeadSignature: input.cutoverSignature,
      coverage: "complete",
    };
    return this.watchTarget;
  }

  public async startSyncRun(input: StartSyncRunInput): Promise<string> {
    this.runs.push(input);
    return `run-${this.runs.length}`;
  }

  public async recordPage(input: RecordPageInput): Promise<void> {
    if (this.failNextRecordPage) {
      this.failNextRecordPage = false;
      throw new Error("injected page storage failure");
    }
    this.pages.push(input);
  }

  public async recordRepresentation(
    input: RecordRepresentationInput,
  ): Promise<RecordRepresentationResult> {
    if (
      input.classification !== "pending" &&
      this.failNextFinalRepresentation
    ) {
      this.failNextFinalRepresentation = false;
      throw new Error("injected representation storage failure");
    }
    this.representations.push(input);
    const signatureKey = `${input.watchTargetId}:${input.discovered.signature}`;
    const signatureInserted = !this.#signatures.has(signatureKey);
    this.#signatures.add(signatureKey);
    let eventsInserted = 0;
    for (const transfer of input.transfers) {
      if (!this.#events.has(transfer.eventId)) {
        this.#events.add(transfer.eventId);
        eventsInserted += 1;
      }
    }
    if (input.classification !== "pending") {
      for (const operation of ["transaction", "storage"] as const) {
        this.resolvedRetries.push({
          operation,
          signature: input.discovered.signature,
        });
      }
    }
    return {
      signatureInserted,
      eventsInserted,
      quarantineInserted: input.classification === "quarantined",
    };
  }

  public async recordRetry(input: RecordRetryInput): Promise<boolean> {
    this.retries.push(input);
    return true;
  }

  public async resolveRetry(input: {
    readonly operation: "page" | "transaction" | "storage";
    readonly signature: string | null;
  }): Promise<boolean> {
    this.resolvedRetries.push(input);
    return true;
  }

  public openRetry(
    operation: "page" | "transaction" | "storage",
    signature: string | null,
  ): boolean {
    const created = this.retries.some(
      (retry) => retry.operation === operation && retry.signature === signature,
    );
    const resolved = this.resolvedRetries.some(
      (retry) => retry.operation === operation && retry.signature === signature,
    );
    return created && !resolved;
  }

  public async completeSyncRun(input: CompleteSyncRunInput): Promise<boolean> {
    this.completions.push(input);
    if (!input.advanceCursor) {
      return false;
    }
    if (
      this.watchTarget.committedHeadSignature !== input.startingHeadSignature
    ) {
      return false;
    }
    this.watchTarget = {
      ...this.watchTarget,
      committedHeadSignature: input.capturedHead?.signature ?? null,
      committedHeadSlot: input.capturedHead?.slot ?? null,
      coverage: input.coverage,
    };
    return true;
  }

  public async claimFinalityCandidates(): Promise<
    readonly FinalityCandidate[]
  > {
    return this.finalityCandidates;
  }

  public async recordFinalityObservation(
    input: RecordFinalityObservationInput,
  ): Promise<RecordFinalityObservationResult> {
    this.finalityObservations.push(input);
    return { applied: true, state: input.nextState };
  }

  public async inspectSignature(
    signature: string,
    options?: { readonly includeRaw?: boolean },
  ): Promise<unknown | null> {
    this.lastInspectionOptions = options;
    if (this.signatureInspection !== null) {
      return this.signatureInspection;
    }
    return (
      this.representations.find(
        (entry) => entry.discovered.signature === signature,
      ) ?? null
    );
  }

  public async close(): Promise<void> {}
}
