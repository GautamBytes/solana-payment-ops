import type { PilotStage } from "../domain/types.js";

export type PilotRunState = "running" | "complete" | "incomplete" | "failed";
export type PilotStageState = "pending" | "in_flight" | "succeeded" | "failed";
export type PilotReportAudience = "private" | "redacted";
export type PilotReportFormat = "json" | "csv" | "html";

export interface CreatePilotRunInput {
  readonly pilotId: string;
  readonly manifestDigest: string;
  readonly manifestBody: string;
  readonly invoiceDigest: string;
  readonly startedAt: Date;
}

export interface PilotRunRecord {
  readonly id: string;
  readonly pilotId: string;
  readonly manifestDigest: string;
  readonly invoiceDigest: string;
  readonly state: PilotRunState;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

export interface ClaimPilotStageInput {
  readonly runId: string;
  readonly now: Date;
}

export interface ClaimedPilotStage {
  readonly runId: string;
  readonly stage: PilotStage;
  readonly ordinal: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly resumed: boolean;
}

export interface CompletePilotStageInput {
  readonly runId: string;
  readonly stage: PilotStage;
  readonly leaseToken: string;
  readonly result: Readonly<Record<string, unknown>>;
  readonly completedAt: Date;
}

export interface FailPilotStageInput {
  readonly runId: string;
  readonly stage: PilotStage;
  readonly leaseToken: string;
  readonly errorCode: string;
  readonly failedAt: Date;
}

export interface RecordPilotReportInput {
  readonly runId: string;
  readonly audience: PilotReportAudience;
  readonly format: PilotReportFormat;
  readonly contentDigest: string;
  readonly byteLength: number;
  readonly createdAt: Date;
}

export interface FinishPilotRunInput {
  readonly runId: string;
  readonly state: Exclude<PilotRunState, "running">;
  readonly completedAt: Date;
}

export interface PilotStageInspection {
  readonly stage: PilotStage;
  readonly ordinal: number;
  readonly state: PilotStageState;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface PilotReportInspection {
  readonly audience: PilotReportAudience;
  readonly format: PilotReportFormat;
  readonly contentDigest: string;
  readonly byteLength: number;
  readonly createdAt: Date;
}

export interface PilotRunInspection extends PilotRunRecord {
  readonly stages: readonly PilotStageInspection[];
  readonly reports: readonly PilotReportInspection[];
}

export interface PilotStore {
  getOrCreateRun(input: CreatePilotRunInput): Promise<PilotRunRecord>;
  claimStage(input: ClaimPilotStageInput): Promise<ClaimedPilotStage | null>;
  completeStage(input: CompletePilotStageInput): Promise<boolean>;
  failStage(input: FailPilotStageInput): Promise<boolean>;
  recordReport(input: RecordPilotReportInput): Promise<void>;
  finishRun(input: FinishPilotRunInput): Promise<boolean>;
  getRun(runId: string): Promise<PilotRunInspection | null>;
  close(): Promise<void>;
}
