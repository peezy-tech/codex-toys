import type { Meka, MekaRun, PluginInstallResult } from "@meka/sdk";
import type { MekaClient, MekaRunSummary, MekaServer } from "@meka/app";

export type BuiltPackageSurface = {
  sdk: Meka;
  run: MekaRun;
  install: PluginInstallResult;
  client: MekaClient;
  server: MekaServer;
  summary: MekaRunSummary;
};
