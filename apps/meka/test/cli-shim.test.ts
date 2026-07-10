import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vite-plus/test";
import {
  installCliShim,
  statusCliShim,
  uninstallCliShim,
  type CliShimOptions,
} from "../src/cli-shim.ts";

test("installs a private executable source launcher and runs it under an ESM ancestor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-cli-shim-source-test-"));
  const options = testOptions(root);
  const shimPath = path.join(options.home as string, ".local", "bin", "meka");
  const receiptPath = path.join(options.stateHome as string, "meka", "cli-shim.json");

  try {
    await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
    const installed = await installCliShim(options);

    expect(installed).toMatchObject({ state: "installed", path: shimPath });
    expect(installed.target).toMatch(/\/apps\/meka\/src\/main\.ts$/);
    const launcherDirectoryMode = (await lstat(path.dirname(shimPath))).mode & 0o777;
    expect(launcherDirectoryMode & 0o700).toBe(0o700);
    expect(launcherDirectoryMode & 0o022).toBe(0);
    expect((await lstat(shimPath)).mode & 0o777).toBe(0o755);
    expect((await lstat(path.dirname(receiptPath))).mode & 0o777).toBe(0o700);
    expect((await lstat(receiptPath)).mode & 0o777).toBe(0o600);

    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      path: string;
      target: string;
    };
    expect(receipt).toMatchObject({ path: shimPath, target: installed.target });

    const executed = await execute(shimPath, ["--help"], root);
    expect(executed.stderr).toBe("");
    expect(executed.stdout).toContain("Meka — a private local control plane");
    await expect(statusCliShim(options)).resolves.toMatchObject({ state: "installed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomically upgrades an owned bundled launcher to a new install target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-cli-shim-built-test-"));
  const firstBundleDirectory = path.join(root, "bundle-a");
  const secondBundleDirectory = path.join(root, "bundle-b");
  const firstBundlePath = path.join(firstBundleDirectory, "cli-shim.mjs");
  const secondBundlePath = path.join(secondBundleDirectory, "cli-shim.mjs");
  const options = testOptions(root);

  try {
    await Promise.all([
      bundleCliShim(firstBundlePath),
      bundleCliShim(secondBundlePath),
    ]);
    await writeFile(
      path.join(firstBundleDirectory, "main.js"),
      'console.log(JSON.stringify({ install: "a", args: process.argv.slice(2) }));\n',
    );
    await writeFile(
      path.join(secondBundleDirectory, "main.js"),
      'console.log(JSON.stringify({ install: "b", args: process.argv.slice(2) }));\n',
    );
    const first = (await import(`${pathToFileURL(firstBundlePath).href}?test=${Date.now()}`)) as {
      installCliShim: typeof installCliShim;
      statusCliShim: typeof statusCliShim;
      uninstallCliShim: typeof uninstallCliShim;
    };
    const second = (await import(`${pathToFileURL(secondBundlePath).href}?test=${Date.now()}`)) as {
      installCliShim: typeof installCliShim;
      statusCliShim: typeof statusCliShim;
      uninstallCliShim: typeof uninstallCliShim;
    };

    const initiallyInstalled = await first.installCliShim(options);
    expect(initiallyInstalled).toMatchObject({
      state: "installed",
      target: path.join(firstBundleDirectory, "main.js"),
    });
    const firstExecution = await execute(initiallyInstalled.path, ["alpha"], root);
    expect(JSON.parse(firstExecution.stdout) as unknown).toEqual({
      install: "a",
      args: ["alpha"],
    });

    const upgraded = await second.installCliShim(options);
    expect(upgraded).toMatchObject({
      state: "installed",
      target: path.join(secondBundleDirectory, "main.js"),
    });
    const executed = await execute(upgraded.path, ["alpha", "two words"], root);
    expect(executed.stderr).toBe("");
    expect(JSON.parse(executed.stdout) as unknown).toEqual({
      install: "b",
      args: ["alpha", "two words"],
    });
    await expect(first.statusCliShim(options)).resolves.toMatchObject({ state: "drifted" });
    await expect(second.statusCliShim(options)).resolves.toMatchObject({ state: "installed" });
    await second.uninstallCliShim(options);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an unowned shim conflict", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-cli-shim-conflict-test-"));
  const options = testOptions(root);
  const shimPath = path.join(options.home as string, ".local", "bin", "meka");
  const receiptPath = path.join(options.stateHome as string, "meka", "cli-shim.json");

  try {
    await mkdir(path.dirname(shimPath), { recursive: true });
    await writeFile(shimPath, "existing launcher\n", { mode: 0o755 });

    await expect(installCliShim(options)).resolves.toMatchObject({ state: "conflict" });
    await expect(statusCliShim(options)).resolves.toMatchObject({ state: "conflict" });
    await expect(uninstallCliShim(options)).resolves.toMatchObject({ state: "conflict" });
    await expect(readFile(shimPath, "utf8")).resolves.toBe("existing launcher\n");
    await expect(lstat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite or remove a content-drifted owned shim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-cli-shim-drift-test-"));
  const options = testOptions(root);
  const shimPath = path.join(options.home as string, ".local", "bin", "meka");
  const replacement = "#!/bin/sh\nexit 19\n";

  try {
    await installCliShim(options);
    await writeFile(shimPath, replacement);

    await expect(statusCliShim(options)).resolves.toMatchObject({ state: "drifted" });
    await expect(installCliShim(options)).resolves.toMatchObject({ state: "drifted" });
    await expect(uninstallCliShim(options)).resolves.toMatchObject({ state: "drifted" });
    await expect(readFile(shimPath, "utf8")).resolves.toBe(replacement);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an executable-mode drift and repairs it during explicit install", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-cli-shim-mode-test-"));
  const options = testOptions(root);
  const shimPath = path.join(options.home as string, ".local", "bin", "meka");
  const receiptPath = path.join(options.stateHome as string, "meka", "cli-shim.json");

  try {
    await installCliShim(options);
    await chmod(shimPath, 0o644);

    await expect(statusCliShim(options)).resolves.toMatchObject({ state: "drifted" });
    await expect(installCliShim(options)).resolves.toMatchObject({ state: "installed" });
    expect((await lstat(shimPath)).mode & 0o777).toBe(0o755);
    await expect(uninstallCliShim(options)).resolves.toMatchObject({ state: "not-installed" });
    await expect(lstat(shimPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not apply a receipt to another home that shares the state root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-cli-shim-receipt-test-"));
  const stateHome = path.join(root, "state");
  const first = { home: path.join(root, "home-a"), stateHome };
  const second = { home: path.join(root, "home-b"), stateHome };
  const firstShim = path.join(first.home, ".local", "bin", "meka");
  const secondShim = path.join(second.home, ".local", "bin", "meka");

  try {
    await installCliShim(first);

    await expect(statusCliShim(second)).resolves.toMatchObject({ state: "conflict" });
    await expect(installCliShim(second)).resolves.toMatchObject({ state: "conflict" });
    await expect(uninstallCliShim(second)).resolves.toMatchObject({ state: "conflict" });
    await expect(lstat(firstShim)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(lstat(secondShim)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(uninstallCliShim(first)).resolves.toMatchObject({ state: "not-installed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers a stale claim under cross-process contention without leaving live claims", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-cli-shim-lock-test-"));
  const options = testOptions(root);
  const bundlePath = path.join(root, "bundle", "cli-shim.mjs");
  const lockPath = path.join(options.stateHome as string, "meka", "cli-shim.json.lock");

  try {
    await bundleCliShim(bundlePath);
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    const staleToken = randomUUID();
    const staleClaim = path.join(lockPath, `claim-${staleToken}`);
    await mkdir(staleClaim, { mode: 0o700 });
    await writeFile(
      path.join(staleClaim, "owner.json"),
      `${JSON.stringify({
        version: 1,
        token: staleToken,
        pid: 2_147_483_647,
        createdAt: "2026-07-10T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    const moduleUrl = pathToFileURL(bundlePath).href;
    const program = `import { installCliShim } from ${JSON.stringify(
      moduleUrl,
    )}; const result = await installCliShim(${JSON.stringify(
      options,
    )}); process.stdout.write(result.state + "\\n");`;
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, async () =>
        execute(process.execPath, ["--input-type=module", "--eval", program], root),
      ),
    );
    expect(outcomes.every((outcome) => outcome.stdout === "installed\n")).toBe(true);
    const bundled = (await import(`${moduleUrl}?status=${Date.now()}`)) as {
      statusCliShim: typeof statusCliShim;
    };
    await expect(bundled.statusCliShim(options)).resolves.toMatchObject({ state: "installed" });
    await expect(readdir(lockPath)).resolves.toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for public receipts and symbolic-link shims", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-cli-shim-path-test-"));
  const options = testOptions(root);
  const shimPath = path.join(options.home as string, ".local", "bin", "meka");
  const receiptPath = path.join(options.stateHome as string, "meka", "cli-shim.json");

  try {
    await installCliShim(options);
    await chmod(receiptPath, 0o644);
    await expect(statusCliShim(options)).rejects.toThrow("receipt is not private");
    await expect(installCliShim(options)).rejects.toThrow("receipt is not private");
    await expect(uninstallCliShim(options)).rejects.toThrow("receipt is not private");

    await rm(receiptPath, { force: true });
    await rm(shimPath, { force: true });
    const target = path.join(root, "target");
    await writeFile(target, "preserve me\n");
    await symlink(target, shimPath);
    await expect(installCliShim(options)).resolves.toMatchObject({ state: "conflict" });
    await expect(statusCliShim(options)).resolves.toMatchObject({ state: "conflict" });
    await expect(uninstallCliShim(options)).resolves.toMatchObject({ state: "conflict" });
    await expect(readFile(target, "utf8")).resolves.toBe("preserve me\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts but never owns the current package-manager launcher symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-cli-shim-external-test-"));
  const bundlePath = path.join(root, "app", "dist", "cli-shim.mjs");
  const packageBin = path.join(root, "app", "bin", "meka.js");
  const options = testOptions(root);
  const shimPath = path.join(options.home, ".local", "bin", "meka");
  try {
    await bundleCliShim(bundlePath);
    await mkdir(path.dirname(packageBin), { recursive: true });
    await writeFile(packageBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await mkdir(path.dirname(shimPath), { recursive: true });
    await symlink(packageBin, shimPath);
    const bundled = (await import(`${pathToFileURL(bundlePath).href}?external=${Date.now()}`)) as {
      installCliShim: typeof installCliShim;
      statusCliShim: typeof statusCliShim;
      uninstallCliShim: typeof uninstallCliShim;
    };

    await expect(bundled.installCliShim(options)).resolves.toMatchObject({ state: "external" });
    await expect(bundled.statusCliShim(options)).resolves.toMatchObject({ state: "external" });
    await expect(bundled.uninstallCliShim(options)).resolves.toMatchObject({ state: "external" });
    expect((await lstat(shimPath)).isSymbolicLink()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function testOptions(root: string): Required<CliShimOptions> {
  return {
    home: path.join(root, "nested", "home"),
    stateHome: path.join(root, "state"),
  };
}

async function bundleCliShim(outfile: string): Promise<void> {
  await mkdir(path.dirname(outfile), { recursive: true });
  await build({
    entryPoints: [path.resolve("apps/meka/src/cli-shim.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
  });
}

async function execute(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, encoding: "utf8", timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
