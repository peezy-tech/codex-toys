import { registerHooks } from "node:module";

const workflowModuleUrl = process.env.MEKA_WORKFLOW_MODULE_URL;

if (!workflowModuleUrl) {
  throw new Error("MEKA_WORKFLOW_MODULE_URL is required by the workflow child loader");
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@meka/workflow") {
      return { url: workflowModuleUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
