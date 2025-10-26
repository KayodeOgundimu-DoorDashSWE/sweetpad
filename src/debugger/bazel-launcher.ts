/**
 * Bazel iOS App Launcher with Debug Support
 *
 * This module provides functionality to launch Bazel-built iOS apps on simulators/devices
 * with debugging support, similar to rules_apple's simulator launcher.
 */

import * as path from "node:path";
import { exec } from "../common/exec";
import { commonLogger } from "../common/logger";
import type { ExtensionContext } from "../common/commands";
import { getSimulatorByUdid } from "../simulators/utils";
import type { SimulatorDestination } from "../simulators/types";
import type { DeviceDestination } from "../devices/types";

export interface BazelLaunchOptions {
  /** Path to the .app bundle */
  appPath: string;
  /** Bundle identifier of the app */
  bundleId: string;
  /** Simulator or device to launch on */
  destination: SimulatorDestination | DeviceDestination;
  /** Whether to wait for debugger to attach before running */
  waitForDebugger: boolean;
  /** Environment variables to pass to the app */
  env?: Record<string, string>;
  /** Arguments to pass to the app */
  args?: string[];
}

export interface BazelLaunchResult {
  /** Process ID of the launched app */
  pid: number;
  /** Bundle identifier */
  bundleId: string;
  /** Device/simulator ID */
  deviceId: string;
  /** Full app path on the device/simulator */
  appPath: string;
}

/**
 * Launch a Bazel-built iOS app on a simulator
 */
export async function launchBazelAppOnSimulator(
  context: ExtensionContext,
  options: BazelLaunchOptions & { destination: SimulatorDestination },
): Promise<BazelLaunchResult> {
  const { appPath, bundleId, destination, waitForDebugger, env = {}, args = [] } = options;
  const simulatorId = destination.udid;

  commonLogger.log("Launching Bazel app on simulator", {
    appPath,
    bundleId,
    simulatorId,
    waitForDebugger,
  });

  // 1. Get simulator with fresh state
  const simulator = await getSimulatorByUdid(context, { udid: simulatorId });

  // 2. Open Simulator.app if not already open
  await exec({
    command: "open",
    args: ["-g", "-a", "Simulator"],
  });

  // 3. Boot simulator if needed
  if (!simulator.isBooted) {
    commonLogger.log(`Booting simulator: ${simulator.name}`);
    await exec({
      command: "xcrun",
      args: ["simctl", "boot", simulator.udid],
    });

    // Wait for simulator to be fully booted
    await waitForSimulatorBoot(simulator.udid);
  }

  // 4. Install app on simulator
  commonLogger.log(`Installing app on simulator: ${simulator.name}`);
  await exec({
    command: "xcrun",
    args: ["simctl", "install", simulator.udid, appPath],
  });

  // 5. Terminate existing instances
  try {
    await exec({
      command: "xcrun",
      args: ["simctl", "terminate", simulator.udid, bundleId],
    });
  } catch (error) {
    // App might not be running, ignore error
  }

  // 6. Launch app with or without debugger flag
  const launchArgs = [
    "simctl",
    "launch",
    ...(waitForDebugger ? ["--wait-for-debugger"] : []),
    "--terminate-running-process",
    simulator.udid,
    bundleId,
    ...args,
  ];

  // Prepare environment variables (simctl requires SIMCTL_CHILD_ prefix)
  const launchEnv = Object.fromEntries(Object.entries(env).map(([key, value]) => [`SIMCTL_CHILD_${key}`, value]));

  commonLogger.log("Launching app", { launchArgs, launchEnv });

  const output = await exec({
    command: "xcrun",
    args: launchArgs,
    env: launchEnv,
  });

  // Parse PID from output
  // Output format: "com.example.MyApp: 12345"
  const pidMatch = output.match(/:\s*(\d+)/);
  if (!pidMatch) {
    throw new Error(`Failed to extract PID from launch output: ${output}`);
  }

  const pid = parseInt(pidMatch[1], 10);

  commonLogger.log("App launched successfully", { pid, bundleId });

  return {
    pid,
    bundleId,
    deviceId: simulator.udid,
    appPath,
  };
}

/**
 * Launch a Bazel-built iOS app on a physical device
 */
export async function launchBazelAppOnDevice(
  context: ExtensionContext,
  options: BazelLaunchOptions & { destination: DeviceDestination },
): Promise<BazelLaunchResult> {
  const { appPath, bundleId, destination, waitForDebugger, env = {}, args = [] } = options;
  const deviceId = destination.udid;

  commonLogger.log("Launching Bazel app on device", {
    appPath,
    bundleId,
    deviceId,
    waitForDebugger,
  });

  // 1. Install app on device
  commonLogger.log(`Installing app on device: ${destination.name}`);
  await exec({
    command: "xcrun",
    args: ["devicectl", "device", "install", "app", "--device", deviceId, appPath],
  });

  // 2. Launch app with devicectl
  const launchArgs = [
    "devicectl",
    "device",
    "process",
    "launch",
    "--device",
    deviceId,
    ...(waitForDebugger ? ["--start-stopped"] : []),
    "--terminate-existing",
    bundleId,
    ...args,
  ];

  // Prepare environment variables (devicectl requires DEVICECTL_CHILD_ prefix)
  const launchEnv = Object.fromEntries(Object.entries(env).map(([key, value]) => [`DEVICECTL_CHILD_${key}`, value]));

  commonLogger.log("Launching app on device", { launchArgs, launchEnv });

  const output = await exec({
    command: "xcrun",
    args: launchArgs,
    env: launchEnv,
  });

  // Parse JSON output to get PID
  let pid: number;
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const jsonOutput = JSON.parse(jsonMatch[0]);
      pid = jsonOutput.result?.process?.processIdentifier;
    }
  } catch (error) {
    // Fallback: try to parse PID from plain output
    const pidMatch = output.match(/processIdentifier[:\s]+(\d+)/);
    if (pidMatch) {
      pid = parseInt(pidMatch[1], 10);
    }
  }

  if (!pid!) {
    throw new Error(`Failed to extract PID from launch output: ${output}`);
  }

  commonLogger.log("App launched successfully on device", { pid, bundleId });

  return {
    pid,
    bundleId,
    deviceId,
    appPath,
  };
}

/**
 * Wait for simulator to finish booting
 */
async function waitForSimulatorBoot(udid: string, timeoutMs: number = 30000): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const output = await exec({
      command: "xcrun",
      args: ["simctl", "list", "devices", "-j", udid],
    });

    try {
      const data = JSON.parse(output);
      const devices = Object.values(data.devices).flat() as any[];
      const device = devices.find((d) => d.udid === udid);

      if (device?.state === "Booted") {
        commonLogger.log("Simulator booted successfully");
        return;
      }
    } catch (error) {
      commonLogger.warn("Failed to parse simulator list output", { error });
    }

    // Wait 1 second before checking again
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Simulator failed to boot within ${timeoutMs}ms`);
}

/**
 * Extract bundle identifier from .app bundle
 */
export async function getBundleIdentifier(appPath: string): Promise<string> {
  const plistPath = path.join(appPath, "Info.plist");

  // Check if the app bundle exists
  try {
    await exec({
      command: "test",
      args: ["-d", appPath],
    });
  } catch (error) {
    throw new Error(`App bundle does not exist: ${appPath}`);
  }

  // Check if Info.plist exists
  try {
    await exec({
      command: "test",
      args: ["-f", plistPath],
    });
  } catch (error) {
    // List contents of app bundle for debugging
    try {
      const contents = await exec({
        command: "ls",
        args: ["-la", appPath],
      });
      commonLogger.warn(`Info.plist not found. App bundle contents:`, {
        appPath,
        contents,
      });
    } catch {
      // Ignore ls error
    }
    throw new Error(`Info.plist not found at: ${plistPath}`);
  }

  // Read bundle identifier
  try {
    const output = await exec({
      command: "/usr/libexec/PlistBuddy",
      args: ["-c", "Print :CFBundleIdentifier", plistPath],
    });
    return output.trim();
  } catch (error) {
    throw new Error(`Failed to read CFBundleIdentifier from ${plistPath}: ${error}`);
  }
}

/**
 * Start debugserver and attach to a process
 * Returns a promise that resolves when debugserver exits
 */
export async function startDebugServer(options: {
  pid: number;
  port: number;
  deviceId?: string;
}): Promise<void> {
  const { pid, port, deviceId } = options;

  // Kill any existing debugserver on this port
  try {
    // Method 1: Find by port using lsof
    const existingProcess = await exec({
      command: "lsof",
      args: ["-ti", `:${port}`],
    }).catch(() => "");

    if (existingProcess.trim()) {
      const pids = existingProcess.trim().split("\n");
      for (const existingPid of pids) {
        if (existingPid) {
          commonLogger.log("Killing existing process on port", { port, pid: existingPid });
          await exec({
            command: "kill",
            args: ["-9", existingPid],
          }).catch(() => {});
        }
      }
    }

    // Method 2: Also try pkill as fallback
    await exec({
      command: "pkill",
      args: ["-9", "-f", `debugserver.*${port}`],
    }).catch(() => {});

    // Wait a bit for processes to die
    await new Promise((resolve) => setTimeout(resolve, 200));
  } catch (error) {
    // Ignore errors - might not be any processes to kill
    commonLogger.debug("Error during cleanup (expected if no existing debugserver)", { error });
  }

  const xcodeDevPath = await exec({
    command: "xcode-select",
    args: ["-p"],
  });

  const debugserverPath = path.join(
    xcodeDevPath.trim(),
    "..",
    "SharedFrameworks",
    "LLDB.framework",
    "Versions",
    "A",
    "Resources",
    "debugserver",
  );

  const debugserverArgs = [`localhost:${port}`, "--attach", pid.toString()];

  // Verify the target process is still running before attaching
  try {
    await exec({
      command: "ps",
      args: ["-p", pid.toString()],
    });
    commonLogger.log("Target process is running", { pid });
  } catch (error) {
    throw new Error(`Target process ${pid} is not running. App may have crashed or exited.`);
  }

  commonLogger.log("Starting debugserver", {
    debugserverPath,
    args: debugserverArgs,
    pid,
    port,
  });

  // Import spawn to run debugserver in background
  const { spawn } = await import("node:child_process");

  // Launch debugserver in background (don't wait for it to complete)
  return new Promise((resolve, reject) => {
    commonLogger.log("Spawning debugserver process...", {
      command: debugserverPath,
      args: debugserverArgs,
    });

    const debugserverProcess = spawn(debugserverPath, debugserverArgs, {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let started = false;
    let allStdout = "";
    let allStderr = "";

    commonLogger.log("debugserver process spawned", {
      pid: debugserverProcess.pid,
    });

    // Listen for stdout/stderr for debugging
    debugserverProcess.stdout?.on("data", (data) => {
      const output = data.toString();
      allStdout += output;
      commonLogger.log("debugserver stdout", { output, total: allStdout });
    });

    debugserverProcess.stderr?.on("data", (data) => {
      const output = data.toString();
      allStderr += output;
      commonLogger.error("debugserver stderr", { output, total: allStderr });

      // Check for common debugserver errors
      if (output.includes("error") || output.includes("failed") || output.includes("unable")) {
        commonLogger.error("debugserver reported error in stderr", { stderr: output });
      }
    });

    debugserverProcess.on("error", (error) => {
      commonLogger.error("debugserver spawn error", {
        error,
        errorType: typeof error,
        errorMessage: (error as any)?.message,
      });
      if (!started) {
        reject(error);
      }
    });

    debugserverProcess.on("exit", (code, signal) => {
      commonLogger.log("debugserver process exited", {
        code,
        signal,
        stdout: allStdout,
        stderr: allStderr,
        wasStarted: started,
        pid: debugserverProcess.pid,
      });

      // If exited before we confirmed it was listening, that's an error
      if (!started) {
        const errorMsg =
          code !== 0
            ? `debugserver exited with code ${code}. stderr: ${allStderr || "(empty)"}, stdout: ${allStdout || "(empty)"}`
            : `debugserver exited unexpectedly (code 0) before listening. stderr: ${allStderr || "(empty)"}, stdout: ${allStdout || "(empty)"}`;
        reject(new Error(errorMsg));
      }
    });

    // debugserver with --attach doesn't print to stdout and port detection
    // from Node.js is unreliable due to permissions/environment issues.
    // We've verified manually that debugserver DOES start listening,
    // so just wait a reasonable time and proceed.
    const waitTime = 2000; // 2 seconds should be plenty for debugserver to attach

    commonLogger.log("Waiting for debugserver to attach and start listening", {
      port,
      waitTime,
      debugserverPid: debugserverProcess.pid,
    });

    setTimeout(() => {
      // Check if process exited during wait
      if (debugserverProcess.exitCode !== null) {
        const errorMsg = `debugserver exited with code ${debugserverProcess.exitCode} during startup. stderr: ${allStderr || "(empty)"}, stdout: ${allStdout || "(empty)"}`;
        commonLogger.error("debugserver exited before timeout", {
          exitCode: debugserverProcess.exitCode,
          stdout: allStdout,
          stderr: allStderr,
        });
        reject(new Error(errorMsg));
        return;
      }

      commonLogger.log("debugserver wait complete, assuming it's listening", {
        processAlive: !debugserverProcess.killed,
        processPid: debugserverProcess.pid,
        exitCode: debugserverProcess.exitCode,
      });

      started = true;
      resolve();
    }, waitTime);
  });
}
