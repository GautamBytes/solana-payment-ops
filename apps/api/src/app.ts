import type { ApiConfig } from "./config.js";
export { buildApiServer, type ApiServerDependencies } from "./server.js";

export interface ApiApp {
  readonly config: ApiConfig;
}

export function createApiApp(config: ApiConfig): ApiApp {
  return Object.freeze({ config });
}
