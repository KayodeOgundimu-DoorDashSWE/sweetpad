# Bazel iOS App Debugging with SweetPad

This document explains how the debugging workflow operates for launching Bazel-built iOS apps and attaching a debugger
from Cursor/VSCode.

## Overview

The Bazel debugging system provides a complete workflow for debugging iOS apps built with Bazel, including:

1. **Building with debug symbols** - Ensures proper debugging experience
2. **Launching with debugger support** - Apps launch in a paused state
3. **Debugserver management** - Automatic setup of debugging infrastructure
4. **LLDB integration** - Seamless connection to VSCode/Cursor debugger

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User triggers "Debug Bazel Target" command                   │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Enhanced Bazel Debug Workflow (bazel-debug.ts)              │
│    Step 1: Build with debug symbols                            │
│    Step 2: Extract app bundle and bundle identifier            │
│    Step 3: Launch app with --wait-for-debugger                 │
│    Step 4: Start debugserver attached to app                   │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Bazel Launcher (bazel-launcher.ts)                          │
│    a. Boot simulator/prepare device                            │
│    b. Install app bundle                                       │
│    c. Launch with --wait-for-debugger flag                     │
│    d. Return PID and app details                               │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Debugserver starts on localhost:6667                        │
│    → Attached to app process, waiting for LLDB                 │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. User starts VSCode debugging                                │
│    → Debug Configuration Provider resolves config              │
│    → LLDB connects via gdb-remote to localhost:6667            │
│    → Debug session begins!                                      │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. `bazel-debug.ts` - Main Workflow Orchestrator

This module implements the complete debug workflow:

```typescript
// Key functions:
-debugBazelAppOnSimulator() - // Simulator debugging workflow
  debugBazelAppOnDevice() - // Device debugging workflow
  enhancedBazelDebugCommand(); // Main entry point
```

**Simulator Workflow:**

1. **Build with debug symbols:**

   ```bash
   bazel build //path/to:target \
     --compilation_mode=dbg \
     --platforms=@build_bazel_apple_support//platforms:ios_sim_arm64 \
     --copt=-g \
     --strip=never
   ```

2. **Extract bundle information:**

   - Locate `.app` bundle in `bazel-bin`
   - Read bundle identifier from `Info.plist`

3. **Launch app with debugger support:**

   ```bash
   xcrun simctl launch \
     --wait-for-debugger \
     --terminate-running-process \
     <simulator-udid> \
     <bundle-id>
   ```

4. **Start debugserver:**
   ```bash
   <xcode-path>/SharedFrameworks/LLDB.framework/.../debugserver \
     localhost:6667 \
     --attach <pid>
   ```

**Device Workflow:**

Similar to simulator but:

- Builds for `arm64` architecture
- Uses `devicectl` for installation and launch
- Handles both `.ipa` and `.app` bundle formats

### 2. `bazel-launcher.ts` - App Launch Management

Provides low-level functions for launching apps:

```typescript
// Key functions:
-launchBazelAppOnSimulator() - // Launch on iOS Simulator
  launchBazelAppOnDevice() - // Launch on physical device
  getBundleIdentifier() - // Extract bundle ID from .app
  startDebugServer() - // Start debugserver process
  waitForSimulatorBoot(); // Ensure simulator is ready
```

**Key Features:**

- **Simulator management:** Boot simulators automatically if needed
- **JSON parsing:** Use `simctl list -j` for reliable state detection
- **Error handling:** Graceful fallbacks for common issues
- **Environment variables:** Proper handling of `SIMCTL_CHILD_*` and `DEVICECTL_CHILD_*` prefixes

### 3. `provider.ts` - Debug Configuration Resolution

Updates to the debug configuration provider:

```typescript
// Enhanced methods:
-resolveBazelSimulatorDebugConfiguration() - // Connect to debugserver for simulator
  resolveBazelDeviceDebugConfiguration(); // Connect to debugserver for device
```

**LLDB Configuration:**

For **simulators**, LLDB connects directly:

```json
{
  "type": "lldb",
  "request": "custom",
  "program": "/path/to/app.app",
  "initCommands": ["gdb-remote localhost:6667"]
}
```

For **devices**, additional setup is required:

```json
{
  "type": "lldb",
  "request": "custom",
  "program": "/path/to/app.app",
  "initCommands": [
    "platform select remote-ios",
    "process handle SIGSTOP -p true -s false -n false",
    "gdb-remote localhost:6667"
  ],
  "preRunCommands": ["script lldb.target.module[0].SetPlatformFileSpec(...)"]
}
```

## Usage

### Basic Usage

1. **Select a Bazel target** in the SweetPad sidebar
2. **Right-click** and select "Debug Bazel Target"
3. **Choose destination** (simulator or device)
4. **Wait for build and launch** - Terminal shows progress
5. **App launches paused** - "⏸️ App is paused, waiting for debugger..."
6. **Debugserver starts** - "🔌 Starting debugserver on port 6667..."
7. **Start debugging** in VSCode:
   - Open Run & Debug panel (Cmd+Shift+D)
   - Select "SweetPad: Build and Run (Wait for debugger)"
   - Click Start Debugging (F5)

### Advanced Configuration

**Custom debug port:**

In `.vscode/launch.json`:

```json
{
  "configurations": [
    {
      "name": "Debug Bazel App",
      "type": "sweetpad-lldb",
      "request": "attach",
      "debugPort": 6668 // Custom port
    }
  ]
}
```

**Launch arguments and environment:**

In `.vscode/settings.json`:

```json
{
  "sweetpad.build.launchArgs": ["--verbose", "--test-mode"],
  "sweetpad.build.launchEnv": {
    "API_HOST": "localhost:8080",
    "DEBUG_LEVEL": "verbose"
  }
}
```

## Differences from Xcode Debugging

| Feature             | Bazel (SweetPad)                                 | Xcode Projects                       |
| ------------------- | ------------------------------------------------ | ------------------------------------ |
| Build system        | Bazel                                            | xcodebuild                           |
| Debug symbols       | `--compilation_mode=dbg --copt=-g --strip=never` | `GCC_GENERATE_DEBUGGING_SYMBOLS=YES` |
| Launch method       | `simctl launch --wait-for-debugger`              | Same                                 |
| Debugserver setup   | Manual via script                                | Automatic in Xcode                   |
| LLDB connection     | `gdb-remote localhost:6667`                      | `waitFor=true`                       |
| App bundle location | `bazel-bin/<package>/<target>.app`               | DerivedData                          |

## Troubleshooting

### Issue: "Failed to connect to debugserver"

**Cause:** Debugserver might not have started or crashed

**Solutions:**

1. Check terminal output for debugserver errors
2. Verify port is available: `lsof -i :6667`
3. Try a different port in debug configuration
4. Ensure Xcode command line tools are installed

### Issue: "Bundle identifier not found"

**Cause:** `.app` bundle or `Info.plist` is missing/corrupted

**Solutions:**

1. Clean and rebuild: `bazel clean` then rebuild
2. Check bundle path in terminal output
3. Verify `Info.plist` exists in bundle
4. Ensure target has proper `bundle_id` attribute

### Issue: "Simulator failed to boot"

**Cause:** Simulator is stuck or Xcode is not properly configured

**Solutions:**

1. Open Simulator.app manually
2. Check simulator status: `xcrun simctl list`
3. Reset simulator: Boot, then Device → Erase All Content and Settings
4. Restart macOS (last resort)

### Issue: "App crashes immediately after launch"

**Cause:** Missing dependencies, wrong architecture, or provisioning issues

**Solutions:**

1. Check app logs in Console.app
2. Verify correct platform flags for Bazel build
3. For devices: Check provisioning profile and code signing
4. Try running without debugger first to isolate issue

### Issue: "Breakpoints not hitting"

**Cause:** Debug symbols not properly embedded or source maps incorrect

**Solutions:**

1. Verify build used `--compilation_mode=dbg`
2. Check that `--strip=never` was applied
3. Ensure source files haven't moved since build
4. Try setting breakpoints after app launches

## Technical Details

### Debug Symbols

Bazel apps require explicit flags to generate debug symbols:

- `--compilation_mode=dbg` - Debug build mode
- `--copt=-g` - Generate DWARF debug info
- `--strip=never` - Prevent symbol stripping

Without these, LLDB won't have symbol information.

### Wait-for-Debugger Flag

The `--wait-for-debugger` flag makes apps pause at launch before `main()`:

- Allows setting breakpoints in early startup code
- Ensures debugger attaches before issues occur
- Required for debugging initialization logic

### Debugserver Port

Default port is `6667`, chosen for:

- Not commonly used by other services
- Easy to remember
- Matches convention in Xcode debugging

You can use any available port by configuring `debugPort` in launch.json.

### Process Lifecycle

1. **Build completes** → app binary with symbols ready
2. **App launches** → paused before `main()`, returns PID
3. **Debugserver starts** → attached to PID, listening on port
4. **LLDB connects** → sends `gdb-remote` command
5. **Debugging begins** → breakpoints set, execution continues
6. **Session ends** → debugserver exits, app process terminated

## Files Created/Modified

### New Files

- `src/debugger/bazel-launcher.ts` - App launch utilities
- `src/debugger/bazel-debug.ts` - Debug workflow implementation
- `docs/wiki/bazel-debug.md` - This documentation

### Modified Files

- `src/build/commands.ts` - Updated `bazelDebugCommand()`
- `src/debugger/provider.ts` - Enhanced Bazel debug config resolution

## Requirements

- macOS with Xcode installed
- Bazel (or Bazelisk) in PATH
- VSCode/Cursor with CodeLLDB extension
- iOS Simulator or device connected
- Valid code signing for device debugging

## Future Improvements

1. **Parallel debugging** - Debug multiple processes/targets simultaneously
2. **Automatic retry** - Retry connection on debugserver startup failures
3. **Port management** - Dynamic port allocation to avoid conflicts
4. **Enhanced logging** - Better visibility into debug session state
5. **watchOS/tvOS support** - Extend beyond iOS
6. **Remote debugging** - Debug on devices over network
7. **Attach to running** - Attach debugger to already-running apps

## References

- [LLDB Remote Debugging](https://lldb.llvm.org/use/remote.html)
- [Bazel iOS Rules](https://github.com/bazelbuild/rules_apple)
- [Apple Developer: Debugging](https://developer.apple.com/documentation/xcode/debugging)
- [VSCode Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)

## Related Documentation

- [SweetPad Debugging](./debug.md) - General debugging guide
- [SweetPad Build System](./build.md) - Build configuration
- [Bazel Build System](https://bazel.build/) - Bazel documentation
