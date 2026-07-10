import type { Meka, MekaRun, PluginInstallResult } from "@meka/sdk";
import type { MekaClient, MekaRunSummary, MekaServer } from "@meka/app";
import type { AutomationRuntime } from "@meka/app";
import type { AnyMekaWorkflow, DurableJobsService, MekaRunsService } from "@meka/workflow";

export type BuiltPackageSurface = {
  sdk: Meka;
  run: MekaRun;
  install: PluginInstallResult;
  client: MekaClient;
  server: MekaServer;
  summary: MekaRunSummary;
  automation: AutomationRuntime;
  workflow: AnyMekaWorkflow;
  durableJobs: DurableJobsService;
  managedRuns: MekaRunsService;
};
