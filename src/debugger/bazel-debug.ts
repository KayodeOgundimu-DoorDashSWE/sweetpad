/**
 * Bazel debugging workflow implementation
 *
 * Implements the complete debug workflow for Bazel iOS apps:
 * 1. Build with debug symbols
 * 2. Launch app with --wait-for-debugger
 * 3. Start debugserver attached to the app process
 * 4. LLDB connects and debugging begins
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionContext } from "../common/commands";
import type { TaskTerminal } from "../common/tasks";
import {
  getBundleIdentifier,
  launchBazelAppOnSimulator,
  launchBazelAppOnDevice,
  startDebugServer,
} from "./bazel-launcher";
import type { SimulatorDestination } from "../simulators/types";
import type { DeviceDestination } from "../devices/types";
import { commonLogger } from "../common/logger";
import { exec } from "../common/exec";
import type { BazelTreeItem } from "../build/tree";

const DEFAULT_DEBUG_PORT = 6667;

export interface BazelDebugOptions {
  /** Bazel target to debug */
  bazelItem: BazelTreeItem;
  /** Destination to debug on */
  destination: SimulatorDestination | DeviceDestination;
  /** Debug port for LLDB connection */
  debugPort?: number;
  /** Launch arguments */
  launchArgs?: string[];
  /** Environment variables */
  launchEnv?: Record<string, string>;
}

/**
 * Complete debug workflow for Bazel iOS apps on simulator
 */
export async function debugBazelAppOnSimulator(
  context: ExtensionContext,
  terminal: TaskTerminal,
  options: BazelDebugOptions & { destination: SimulatorDestination },
): Promise<void> {
  const { bazelItem, destination, debugPort = DEFAULT_DEBUG_PORT, launchArgs = [], launchEnv = {} } = options;

  terminal.write(`🐛 Starting debug workflow for ${bazelItem.target.name}\n\n`);

  // Step 1: Build with debug symbols
  terminal.write(`🔨 Step 1/4: Building with debug symbols...\n`);
  await terminal.execute({
    command: "sh",
    args: [
      "-c",
      `cd "${bazelItem.package.path}" && bazel build ${bazelItem.target.buildLabel} ` +
        `--compilation_mode=dbg ` +
        `--platforms=@build_bazel_apple_support//platforms:ios_sim_arm64 ` +
        `--copt=-g ` + // Generate debug symbols
        `--strip=never`, // Don't strip symbols
    ],
  });

  // Step 2: Get the app bundle path
  terminal.write(`\n📦 Step 2/4: Locating app bundle...\n`);
  // Convert build label to path: "//Apps/Foo:Bar" → "Apps/Foo/Bar"
  const packagePath = bazelItem.target.buildLabel.replace("//", "").replace(":", "/");

  // Bazel's bazel-bin symlink is usually at the workspace root, not the package directory
  // Try multiple possible locations
  const possiblePaths = [
    // Try workspace root (most common)
    path.resolve(bazelItem.package.path, `../../bazel-bin/${packagePath}.app`),
    // Try package directory
    path.resolve(bazelItem.package.path, `bazel-bin/${packagePath}.app`),
    // Try one level up
    path.resolve(bazelItem.package.path, `../bazel-bin/${packagePath}.app`),
  ];

  let appPath: string | undefined;
  for (const tryPath of possiblePaths) {
    try {
      await terminal.execute({
        command: "test",
        args: ["-d", tryPath],
      });
      appPath = tryPath;
      terminal.write(`   Found app bundle: ${appPath}\n`);
      break;
    } catch {
      // Try next path
    }
  }

  if (!appPath) {
    terminal.write(`   ❌ App bundle not found. Tried:\n`);
    for (const tryPath of possiblePaths) {
      terminal.write(`      - ${tryPath}\n`);
    }
    throw new Error(`App bundle not found. Bazel reported: bazel-bin/${packagePath}.app`);
  }

  // Get bundle identifier
  const bundleId = await getBundleIdentifier(appPath);
  terminal.write(`   Bundle ID: ${bundleId}\n`);

  // Step 3: Launch app with wait-for-debugger
  terminal.write(`\n🚀 Step 3/4: Launching app on simulator with debugger flag...\n`);
  terminal.write(`   Simulator: ${destination.name} (${destination.udid})\n`);

  const launchResult = await launchBazelAppOnSimulator(context, {
    appPath,
    bundleId,
    destination,
    waitForDebugger: true,
    env: launchEnv,
    args: launchArgs,
  });

  terminal.write(`   ✅ App launched, PID: ${launchResult.pid}\n`);
  terminal.write(`   ⏸️  App is paused, waiting for debugger to attach...\n`);

  // Store launch context for debugger provider
  const launchContext = {
    type: "bazel-simulator" as const,
    appPath,
    targetName: bazelItem.target.name,
    buildLabel: bazelItem.target.buildLabel,
    simulatorId: destination.udid,
    simulatorName: destination.name,
  };

  terminal.write(`\n📋 Storing launch context for debugger...\n`);
  terminal.write(`   Type: ${launchContext.type}\n`);
  terminal.write(`   App Path: ${launchContext.appPath}\n`);
  terminal.write(`   Target: ${launchContext.targetName}\n`);
  terminal.write(`   Simulator: ${launchContext.simulatorName}\n`);

  context.updateWorkspaceState("build.lastLaunchedApp", launchContext);

  // Verify it was stored
  const stored = context.getWorkspaceState("build.lastLaunchedApp");
  terminal.write(`   ✅ Stored: ${stored ? "YES" : "NO"}\n`);
  if (stored) {
    commonLogger.log("Launch context stored", { stored });
  }

  // Step 4: Start debugserver
  terminal.write(`\n🔌 Step 4/4: Starting debugserver and attaching debugger...\n`);
  terminal.write(`   Starting debugserver on port ${debugPort}...\n`);

  // Start debugserver in background (non-blocking)
  const debugServerPromise = startDebugServer({
    pid: launchResult.pid,
    port: debugPort,
  }).catch((error) => {
    commonLogger.warn(`Debugserver exited: ${error}`);
    terminal.write(`   ⚠️  Debugserver exited: ${error}\n`);
  });

  // Give debugserver time to start and ensure workspace state is ready
  terminal.write(`   ⏱️  Waiting 1 second for debugserver to initialize...\n`);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Step 5: Automatically start VSCode debugging
  terminal.write(`\n🐛 Attempting to start VSCode debugger...\n`);

  try {
    // Get workspace folder
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    terminal.write(`   Workspace folder: ${workspaceFolder?.name || "undefined"}\n`);
    terminal.write(`   Workspace path: ${workspaceFolder?.uri.fsPath || "undefined"}\n`);

    // Use sweetpad-bazel-lldb type to trigger BazelDebugConfigurationProvider
    const debugConfig: vscode.DebugConfiguration = {
      type: "sweetpad-bazel-lldb",
      request: "attach",
      name: "SweetPad: Bazel Debug",
      debugPort: debugPort, // Pass the port to the provider
    };

    terminal.write(`   Debug config:\n`);
    terminal.write(`     - type: ${debugConfig.type}\n`);
    terminal.write(`     - request: ${debugConfig.request}\n`);
    terminal.write(`     - debugPort: ${debugConfig.debugPort}\n`);

    commonLogger.log("Starting Bazel debug session", {
      workspaceFolder: workspaceFolder?.name,
      debugConfig,
      launchContext: stored,
    });

    terminal.write(`   Calling vscode.debug.startDebugging()...\n`);
    const started = await vscode.debug.startDebugging(workspaceFolder, debugConfig);

    terminal.write(`   Result: ${started ? "SUCCESS" : "FAILED"}\n`);

    if (started) {
      terminal.write(`\n   ✅ Debugger attached successfully!\n\n`);
      terminal.write(`🎉 Happy debugging! Set breakpoints and inspect variables.\n`);
      terminal.write(`   (The terminal will remain open until you stop debugging)\n\n`);
      commonLogger.log("Debugger started successfully");
    } else {
      terminal.write(`\n   ⚠️  Failed to start debugger automatically.\n`);
      terminal.write(`   Please start debugging manually by pressing F5 or using Run & Debug panel.\n\n`);
      commonLogger.warn("Failed to start debugger - returned false");
    }
  } catch (error) {
    terminal.write(`\n   ❌ Error starting debugger: ${error}\n`);
    terminal.write(`   Error type: ${error instanceof Error ? error.constructor.name : typeof error}\n`);
    if (error instanceof Error) {
      terminal.write(`   Error message: ${error.message}\n`);
      if (error.stack) {
        terminal.write(`   Stack trace:\n${error.stack}\n`);
      }
    }
    terminal.write(`\n   Please start debugging manually by pressing F5.\n\n`);
    commonLogger.error("Error starting debugger", { error });
  }

  // Wait for debugserver to complete (when user stops debugging)
  await debugServerPromise;

  terminal.write(`\n✅ Debug session completed\n`);
}

/**
 * Complete debug workflow for Bazel iOS apps on device
 */
export async function debugBazelAppOnDevice(
  context: ExtensionContext,
  terminal: TaskTerminal,
  options: BazelDebugOptions & { destination: DeviceDestination },
): Promise<void> {
  const { bazelItem, destination, debugPort = DEFAULT_DEBUG_PORT, launchArgs = [], launchEnv = {} } = options;

  terminal.write(`🐛 Starting debug workflow for ${bazelItem.target.name} on device\n\n`);

  // Step 1: Build with debug symbols for device
  terminal.write(`🔨 Step 1/4: Building for device with debug symbols...\n`);
  await terminal.execute({
    command: "sh",
    args: [
      "-c",
      `cd "${bazelItem.package.path}" && bazel build ${bazelItem.target.buildLabel} ` +
        `--compilation_mode=dbg ` +
        `--ios_multi_cpus=arm64 ` +
        `--copt=-g ` +
        `--strip=never`,
    ],
  });

  // Step 2: Get the app bundle path
  terminal.write(`\n📦 Step 2/4: Locating app bundle...\n`);
  // Convert build label to path: "//Apps/Foo:Bar" → "Apps/Foo/Bar"
  const packagePath = bazelItem.target.buildLabel.replace("//", "").replace(":", "/");

  // Bazel's bazel-bin symlink is usually at the workspace root, not the package directory
  // Try multiple possible locations for both .ipa and .app
  const basePaths = [
    path.resolve(bazelItem.package.path, `../../bazel-bin/${packagePath}`),
    path.resolve(bazelItem.package.path, `bazel-bin/${packagePath}`),
    path.resolve(bazelItem.package.path, `../bazel-bin/${packagePath}`),
  ];

  let appPath: string | undefined;
  for (const basePath of basePaths) {
    // Try .ipa first (device builds often produce this)
    const ipaPath = `${basePath}.ipa`;
    try {
      await exec({ command: "test", args: ["-e", ipaPath] });
      appPath = ipaPath;
      terminal.write(`   Found IPA: ${appPath}\n`);
      break;
    } catch {
      // Try .app
      const appBundlePath = `${basePath}.app`;
      try {
        await exec({ command: "test", args: ["-e", appBundlePath] });
        appPath = appBundlePath;
        terminal.write(`   Found APP: ${appPath}\n`);
        break;
      } catch {
        // Try next base path
      }
    }
  }

  if (!appPath) {
    terminal.write(`   ❌ App bundle not found. Tried:\n`);
    for (const basePath of basePaths) {
      terminal.write(`      - ${basePath}.ipa\n`);
      terminal.write(`      - ${basePath}.app\n`);
    }
    throw new Error(`App bundle not found. Bazel reported: bazel-bin/${packagePath}.{ipa,app}`);
  }

  // Get bundle identifier
  const bundleId = await getBundleIdentifier(appPath);
  terminal.write(`   Bundle ID: ${bundleId}\n`);

  // Step 3: Launch app with wait-for-debugger
  terminal.write(`\n🚀 Step 3/4: Installing and launching app on device...\n`);
  terminal.write(`   Device: ${destination.name} (${destination.udid})\n`);

  const launchResult = await launchBazelAppOnDevice(context, {
    appPath,
    bundleId,
    destination,
    waitForDebugger: true,
    env: launchEnv,
    args: launchArgs,
  });

  terminal.write(`   ✅ App launched, PID: ${launchResult.pid}\n`);
  terminal.write(`   ⏸️  App is paused, waiting for debugger to attach...\n`);

  // Store launch context for debugger provider
  context.updateWorkspaceState("build.lastLaunchedApp", {
    type: "bazel-device",
    appPath,
    targetName: bazelItem.target.name,
    buildLabel: bazelItem.target.buildLabel,
    destinationId: destination.udid,
    destinationType: destination.type,
  });

  // Step 4: Start debugserver
  terminal.write(`\n🔌 Step 4/4: Starting debugserver and attaching debugger...\n`);
  terminal.write(`   Note: Device debugging requires network connection between host and device\n`);
  terminal.write(`   Starting debugserver on port ${debugPort}...\n`);

  // Start debugserver in background (non-blocking)
  const debugServerPromise = startDebugServer({
    pid: launchResult.pid,
    port: debugPort,
    deviceId: destination.udid,
  }).catch((error) => {
    commonLogger.warn(`Debugserver exited: ${error}`);
  });

  // Give debugserver time to start and ensure workspace state is ready
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Step 5: Automatically start VSCode debugging
  terminal.write(`\n🐛 Attempting to start VSCode debugger...\n`);

  try {
    // Get workspace folder
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    terminal.write(`   Workspace folder: ${workspaceFolder?.name || "undefined"}\n`);

    // Use sweetpad-bazel-lldb type to trigger BazelDebugConfigurationProvider
    const debugConfig: vscode.DebugConfiguration = {
      type: "sweetpad-bazel-lldb",
      request: "attach",
      name: "SweetPad: Bazel Debug (Device)",
      debugPort: debugPort, // Pass the port to the provider
    };

    terminal.write(`   Debug config:\n`);
    terminal.write(`     - type: ${debugConfig.type}\n`);
    terminal.write(`     - request: ${debugConfig.request}\n`);
    terminal.write(`     - debugPort: ${debugConfig.debugPort}\n`);

    commonLogger.log("Starting Bazel debug session (device)", {
      workspaceFolder: workspaceFolder?.name,
      debugConfig,
    });

    terminal.write(`   Calling vscode.debug.startDebugging()...\n`);
    const started = await vscode.debug.startDebugging(workspaceFolder, debugConfig);

    if (started) {
      terminal.write(`\n   ✅ Debugger attached successfully!\n\n`);
      terminal.write(`🎉 Happy debugging! Set breakpoints and inspect variables.\n`);
      terminal.write(`   (The terminal will remain open until you stop debugging)\n\n`);
      commonLogger.log("Debugger started successfully");
    } else {
      terminal.write(`\n   ⚠️  Failed to start debugger automatically.\n`);
      terminal.write(`   Please start debugging manually by pressing F5 or using Run & Debug panel.\n\n`);
      commonLogger.warn("Failed to start debugger - returned false");
    }
  } catch (error) {
    terminal.write(`\n   ❌ Error starting debugger: ${error}\n`);
    if (error instanceof Error) {
      terminal.write(`   Error message: ${error.message}\n`);
    }
    terminal.write(`\n   Please start debugging manually by pressing F5.\n\n`);
    commonLogger.error("Error starting debugger", { error });
  }

  // Wait for debugserver to complete (when user stops debugging)
  await debugServerPromise;

  terminal.write(`\n✅ Debug session completed\n`);
}

/**
 * Enhanced debug command that uses the full workflow
 */
export async function enhancedBazelDebugCommand(
  context: ExtensionContext,
  terminal: TaskTerminal,
  options: BazelDebugOptions,
): Promise<void> {
  const { destination } = options;

  commonLogger.log("Starting enhanced Bazel debug command", {
    targetName: options.bazelItem.target.name,
    destinationType: destination.type,
  });

  if (destination.type === "iOSSimulator") {
    await debugBazelAppOnSimulator(context, terminal, {
      ...options,
      destination,
    });
  } else if (destination.type === "iOSDevice") {
    await debugBazelAppOnDevice(context, terminal, {
      ...options,
      destination,
    });
  } else {
    throw new Error(`Unsupported destination type for Bazel debugging: ${destination.type}`);
  }
}
