# Automatic Debugging in SweetPad

SweetPad now supports **automatic debugger attachment** for both Bazel and Xcode builds - no more manual F5 required!

## Overview

When you click the debug button in SweetPad, the extension now:

1. ✅ Builds your app with debug symbols
2. 🚀 Launches the app (paused before main)
3. 🐛 **Automatically starts the VSCode debugger**
4. 🎉 You're ready to debug immediately!

## How to Use

### Bazel Debugging

1. **Select a Bazel target** in the SweetPad sidebar
2. **Click the debug icon** (🐛) or right-click → "Debug Bazel Target"
3. **Wait** for the automatic workflow to complete
4. **Debug!** The debugger is attached and ready

### Xcode Debugging

1. **Select an Xcode scheme** in the SweetPad sidebar
2. **Right-click** → "Debug Run"
3. **Wait** for the automatic workflow to complete
4. **Debug!** The debugger is attached and ready

## Technical Details

### Two Debug Workflows

SweetPad uses **two separate debug providers** to handle different scenarios:

#### 1. Automatic Debugging (Recommended)

**BazelDebugConfigurationProvider** (`sweetpad-bazel-lldb`)

- For Bazel targets only
- Uses custom debugserver on port 6667
- Full control over debug lifecycle
- Workflow:
  ```
  Build → Launch (background) → Start debugserver (background)
  → Wait 1s → Auto-attach debugger → Debugging begins!
  ```

**DynamicDebugConfigurationProvider** (`sweetpad-lldb`)

- For Xcode builds with "Debug Run" command
- Uses standard iOS simulator debugging
- Simpler attachment mechanism
- Workflow:
  ```
  Build → Launch (background) → Wait 1.5s
  → Auto-attach debugger → Debugging begins!
  ```

#### 2. Manual Debugging (F5 Workflow)

**DynamicDebugConfigurationProvider** (`sweetpad-lldb`)

- For any launched app
- Traditional VSCode debugging workflow
- Press F5 to attach manually
- Workflow:
  ```
  Build → Launch → User presses F5 → Debugger attaches
  ```

### Key Implementation Details

**Non-blocking App Launch**

Both automatic workflows run the app launch in the background:

```typescript
// Before: This would block forever
await terminal.execute({
  command: "xcrun",
  args: ["simctl", "launch", "--wait-for-debugger", ...]
});

// After: Non-blocking - continues to debugger setup
const launchPromise = terminal.execute({
  command: "xcrun",
  args: ["simctl", "launch", "--wait-for-debugger", ...]
}).catch((error) => {
  commonLogger.warn(`App launch exited: ${error}`);
});

await new Promise(resolve => setTimeout(resolve, 1500));
// Now we can start the debugger!
```

**Automatic Debugger Start**

The extension calls VSCode's debug API programmatically:

```typescript
// Bazel: Uses custom provider
const debugConfig = {
  type: "sweetpad-bazel-lldb",
  request: "attach",
  name: "SweetPad: Bazel Debug",
  debugPort: 6667,
};

const started = await vscode.debug.startDebugging(workspaceFolder, debugConfig);

// Xcode: Uses standard provider
const debugConfig = {
  type: "sweetpad-lldb",
  request: "attach",
  name: "SweetPad: Debug",
};

const started = await vscode.debug.startDebugging(workspaceFolder, debugConfig);
```

### Provider Resolution

When `startDebugging()` is called, VSCode invokes the appropriate provider:

**For Bazel (`sweetpad-bazel-lldb`):**

```typescript
class BazelDebugConfigurationProvider {
  resolveDebugConfiguration(folder, config) {
    return {
      type: "lldb-dap",
      request: "attach",
      attachCommands: [`process connect connect://localhost:${config.debugPort || 6667}`],
      internalConsoleOptions: "openOnSessionStart",
      timeout: 1000,
    };
  }
}
```

**For Xcode (`sweetpad-lldb`):**

```typescript
class DynamicDebugConfigurationProvider {
  resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
    const launchContext = getWorkspaceState("build.lastLaunchedApp");

    return {
      type: "lldb",
      request: "attach",
      waitFor: true,
      program: launchContext.appPath,
    };
  }
}
```

## Comparison Table

| Feature         | Bazel (Automatic)     | Xcode (Automatic) | Manual (F5)     |
| --------------- | --------------------- | ----------------- | --------------- |
| **Trigger**     | Click debug icon      | Click "Debug Run" | Press F5        |
| **Provider**    | `sweetpad-bazel-lldb` | `sweetpad-lldb`   | `sweetpad-lldb` |
| **Debugserver** | Custom (port 6667)    | Built-in          | Built-in        |
| **LLDB Type**   | `lldb-dap`            | `lldb`            | `lldb`          |
| **Connection**  | `process connect`     | `waitFor: true`   | `waitFor: true` |
| **Wait Time**   | 1 second              | 1.5 seconds       | N/A             |
| **User Action** | None - automatic      | None - automatic  | Press F5        |

## Benefits

### 1. **Faster Development**

- No more switching to Run & Debug panel
- No more finding the right debug configuration
- No more pressing F5

### 2. **Better UX**

- Single-click debugging
- Clear progress indication in terminal
- Immediate feedback if something goes wrong

### 3. **Consistent Workflow**

- Same experience for Bazel and Xcode
- Works across simulators and devices
- Predictable behavior

### 4. **More Reliable**

- Proper timing and synchronization
- Better error handling
- Detailed logging for troubleshooting

## Troubleshooting

### Debugger doesn't start automatically

**Check the terminal output** for error messages:

- "Result: FAILED" - The debugger call failed
- Error messages will indicate what went wrong
- Common causes: port in use, app crashed, timeout

**Try manual debugging:**

1. Launch the app normally (Build & Run)
2. Press F5 to attach manually
3. If this works, there's an issue with automatic attachment

### Bazel debugging fails to connect

**Check debugserver:**

```bash
# Check if debugserver is running
ps aux | grep debugserver

# Check if port 6667 is listening
lsof -i :6667
# or
netstat -an | grep 6667
```

**Try a different port:**

In your debug workflow, the extension will try port 6667 by default. The port should be automatically available after a
previous debug session ends.

### Xcode debugging hangs

**Check the terminal** for:

- "Waiting for app to launch with debugger flag..."
- "Calling vscode.debug.startDebugging()..."
- "Result: SUCCESS/FAILED"

**Common issues:**

- App taking too long to launch (> 1.5s)
- Simulator not ready
- App crashed on launch

## Future Improvements

1. **Dynamic port allocation** - Auto-select available port if default is busy
2. **Faster attachment** - Optimize wait times based on system performance
3. **Better progress indication** - Real-time status updates
4. **Retry logic** - Automatic retry on transient failures
5. **Device support improvements** - Optimize device debugging workflow

## Related Documentation

- [Bazel Debugging Guide](./bazel-debug.md) - Detailed Bazel debugging documentation
- [General Debugging Guide](./debug.md) - Overall debugging guide for SweetPad
- [Implementation Notes](../dev/bazel-debug-implementation.md) - Technical implementation details

---

**Status:** ✅ Feature Complete and Ready to Use!
