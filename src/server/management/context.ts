import type { OcxConfig } from "../../types";
import type { providerDestinationResolvedError } from "../../lib/destination-policy";
import type { createProviderModelProbeFetch } from "../../lib/provider-outbound";
import type { StartupInstallAction } from "../startup-action-control";

export interface ManagementApiDeps {
  toggleCodexMultiAgentV2?: (enabled: boolean) => void;
  refreshCodexCatalog?: () => Promise<void>;
  clearThreadAccountMap?: () => void;
  clearProviderQuotaCache?: () => void;
  primeCodexPoolQuotas?: (config: OcxConfig, reason: string) => Promise<void> | void;
  runStartupInstallAction?: (
    action: StartupInstallAction,
    options?: { repair?: boolean },
  ) => Promise<{ message: string }>;
  providerDestinationResolvedError?: typeof providerDestinationResolvedError;
  createProviderModelProbeFetch?: typeof createProviderModelProbeFetch;
}


export interface ManagementContext {
  req: Request;
  url: URL;
  config: OcxConfig;
  deps: ManagementApiDeps;
  refreshCodexCatalogBestEffort: () => Promise<void>;
  syncClaudeAgentDefsBestEffort: () => Promise<void>;
}
