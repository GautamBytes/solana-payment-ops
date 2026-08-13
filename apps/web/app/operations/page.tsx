import { cookies } from "next/headers";
import { OperationsDashboard } from "../../components/operations-dashboard";
import {
  getOperationalHealth,
  getOperationalIncidentHistory,
  getProductionControl,
  listOperationalIncidents,
  listPaymentExceptions,
  OperationsApiError,
  type ExceptionReviewState,
} from "../../lib/operations-api";
import { payopsCookieHeader } from "../../lib/auth-cookie";
import {
  acknowledgeIncidentAction,
  assignExceptionAction,
  exportAccountingAction,
  generateEvidenceAction,
  promoteProductionAction,
  resolveIncidentAction,
  resolveExceptionAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function OperationsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly notice?: string | readonly string[];
  }>;
}) {
  const store = await cookies();
  const cookie = payopsCookieHeader(store.getAll());
  const [exceptionResult, productionResult, healthResult, incidentResult] =
    await Promise.all([
      loadSection(() => loadExceptions(cookie)),
      loadSection(() => getProductionControl(cookie)),
      loadSection(() => getOperationalHealth(cookie)),
      loadSection(() => listOperationalIncidents(cookie, { limit: 50 })),
    ]);
  const historyResult =
    incidentResult.data?.data[0] === undefined
      ? ({ state: "available", data: [] } as const)
      : await loadSection(() =>
          getOperationalIncidentHistory(
            cookie,
            incidentResult.data!.data[0]!.id,
            { limit: 20 },
          ).then((page) => page.data),
        );
  const notice = noticeMessage((await searchParams).notice);
  return (
    <OperationsDashboard
      exceptions={exceptionResult.data ?? []}
      exceptionState={exceptionResult.state}
      {...(productionResult.data === undefined
        ? { authorityState: productionResult.state }
        : { production: productionResult.data })}
      {...(healthResult.data === undefined
        ? { healthState: healthResult.state }
        : { health: healthResult.data })}
      {...(incidentResult.data === undefined
        ? { incidentState: incidentResult.state }
        : {
            incidents: incidentResult.data.data,
          })}
      {...(historyResult.data === undefined
        ? { historyState: historyResult.state }
        : { incidentHistory: historyResult.data })}
      {...(notice === undefined ? {} : { notice })}
      now={new Date()}
      actions={{
        assign: assignExceptionAction,
        resolve: resolveExceptionAction,
        evidence: generateEvidenceAction,
        export: exportAccountingAction,
        acknowledgeIncident: acknowledgeIncidentAction,
        resolveIncident: resolveIncidentAction,
        promoteProduction: promoteProductionAction,
      }}
    />
  );
}

type SectionResult<T> =
  | { readonly state: "available"; readonly data: T }
  | {
      readonly state: "unauthorized" | "unavailable";
      readonly data?: undefined;
    };

async function loadSection<T>(
  operation: () => Promise<T>,
): Promise<SectionResult<T>> {
  try {
    return { state: "available", data: await operation() };
  } catch (error) {
    return {
      state:
        error instanceof OperationsApiError &&
        ["authentication_required", "forbidden"].includes(error.code)
          ? "unauthorized"
          : "unavailable",
    };
  }
}

async function loadExceptions(cookie: string) {
  const activeStates: readonly ExceptionReviewState[] = [
    "open",
    "assigned",
    "investigating",
    "escalated",
  ];
  const closedStates: readonly ExceptionReviewState[] = ["resolved", "ignored"];
  const [activePages, closedPages] = await Promise.all([
    Promise.all(
      activeStates.map((state) =>
        listPaymentExceptions(cookie, { limit: 100, state }),
      ),
    ),
    Promise.all(
      closedStates.map((state) =>
        listPaymentExceptions(cookie, { limit: 25, state }),
      ),
    ),
  ]);
  return [...activePages, ...closedPages]
    .flatMap((page) => page.data)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function noticeMessage(value: string | readonly string[] | undefined) {
  const notice = typeof value === "string" ? value : undefined;
  switch (notice) {
    case "incident_acknowledged":
      return { tone: "status" as const, message: "Incident acknowledged." };
    case "incident_resolved":
      return { tone: "status" as const, message: "Incident resolved." };
    case "production_live":
      return {
        tone: "status" as const,
        message: "Production mode is now live.",
      };
    case "mutation_conflict":
      return {
        tone: "conflict" as const,
        message:
          "The incident changed. Review the latest version and try again.",
      };
    case "promotion_blocked":
      return {
        tone: "conflict" as const,
        message:
          "Promotion is blocked. Clear the listed authority gate and try again.",
      };
    case "authorization_required":
      return {
        tone: "conflict" as const,
        message: "A fresh authorized session is required for this action.",
      };
    default:
      return undefined;
  }
}
