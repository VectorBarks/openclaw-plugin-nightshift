# openclaw-plugin-nightshift

**Respect the user's workflow — heavy processing during off-hours only.**

This plugin gives your OpenClaw agent a sense of *when* to do its heavy thinking. LLM-intensive tasks like contemplation, trait crystallization, and metabolism batch processing get scheduled for off-hours — either by the clock or by the user saying "good night." When the user comes back, everything pauses. When they leave again, it picks up where it left off.

## What This Actually Does

If your agent has background work to do — processing conversation implications, crystallizing traits, running contemplative inquiries — all of that takes LLM calls. Those calls compete with the user's actual conversations for resources and attention. Nobody wants their agent chewing through a batch metabolism run while they're trying to have a conversation.

Nightshift solves this by creating a clear boundary: user time is user time, and processing time is processing time. It manages a priority-ordered task queue that only runs during off-hours, pauses instantly when the user shows up, and resumes when they're gone again.

## How It Works

### Time-Based Processing Hours

By default, nightshift activates between 10:30 PM and 5:00 AM Pacific. During this window, queued tasks get processed in priority order. Outside this window, nothing runs. Both the start time, end time, and timezone are configurable.

**Note:** The config key is `processingHours` (renamed from `defaultOfficeHours` for clarity). The old key still works for backwards compatibility.

### Phrase-Triggered Activation

The clock-based window is the fallback. The real trigger is conversational. When the user says "good night," "heading to bed," "calling it a night," or any of a dozen similar phrases, nightshift detects it and starts the countdown. When the user says "good morning," "im back," or similar, nightshift shuts down immediately — even if the clock says it's still office hours.

This means if your user goes to bed at 9 PM one night and midnight the next, nightshift adapts. The schedule follows the human, not the clock.

### The Good Night Buffer

When a bedtime phrase is detected, nightshift doesn't immediately start grinding through tasks. It waits a configurable buffer period (default: 30 minutes) before beginning. This accounts for the "one more thing" messages that come in after someone says good night. The buffer gives the user space to actually be done before heavy processing begins.

### Interruptible Processing

If the user sends a message while a task is running, nightshift pauses the current task immediately and marks it for resume. The agent's full attention returns to the user. After the user goes quiet again (default: 5 minutes of inactivity), queued tasks resume.

This isn't a polite suggestion — `before_agent_start` catches every incoming interaction and flags the running task as paused. The task runner is expected to check for this and yield.

### Priority-Ordered Task Queue

Tasks are queued with explicit priorities. Higher numbers run first:

| Task Type | Priority | Max Per Night |
|---|---|---|
| `contemplation` | 50 | 3 |
| `crystallization` | 25 | 2 |
| `metabolismBatch` | 10 | 5 |

This ordering is intentional. Contemplative inquiry is the most resource-intensive and benefits most from uninterrupted time. Crystallization needs focused evaluation. Metabolism batches are lighter and can fill the remaining cycles. The total number of cycles per night is capped (default: 10).

Failed tasks get re-queued automatically, up to 3 attempts.

### Task Runner Registration

Nightshift doesn't know how to run any of these tasks itself. It's a scheduler, not an executor. Other plugins register their task runners with nightshift, and nightshift calls them during off-hours. This keeps the scheduling logic completely separate from the processing logic.

## For Other Plugin Authors

Nightshift exposes a global bus at `global.__ocNightshift` so other plugins can register task runners and queue tasks without needing a direct dependency. This pattern exists because OpenClaw plugins don't have a built-in way to import each other — they load independently and may initialize in any order. The global bus is the coordination point.

### Registering a Task Runner

Call this during your plugin's `register()` phase. If nightshift hasn't loaded yet, you may need to defer registration or check for the global's existence:

```javascript
register(api) {
    // Wait for nightshift to be available
    const register = () => {
        if (global.__ocNightshift) {
            global.__ocNightshift.registerTaskRunner('myTaskType', async (task, ctx) => {
                // Your processing logic here
                // task.paused will be set to true if the user interrupts — check it and yield
                api.logger.info(`Processing task: ${task.id}`);
            });
        }
    };

    register();
    // Or defer: setTimeout(register, 1000);
}
```

### Queuing a Task

Queue a task from anywhere — a heartbeat hook, an event handler, a gateway method:

```javascript
if (global.__ocNightshift) {
    global.__ocNightshift.queueTask('main', {
        type: 'myTaskType',
        priority: 30,
        data: { whatever: 'your runner needs' }
    });
}
```

The `queueTask` call takes an agent ID (use `'main'` for single-agent setups) and a task object. The task object must have a `type` that matches a registered runner. `priority` determines queue position (higher = runs first). Everything else in the object gets passed through to your runner.

### Checking State

```javascript
if (global.__ocNightshift) {
    const inOfficeHours = global.__ocNightshift.isInOfficeHours('main');
    const userActive = global.__ocNightshift.isUserActive('main');
}
```

## Installation

```bash
git clone https://github.com/CoderofTheWest/openclaw-plugin-nightshift.git
openclaw plugins install ./openclaw-plugin-nightshift
```

Then restart your OpenClaw gateway.

## Configuration Reference

Override any defaults in your `openclaw.json` plugin config:

```json
{
  "plugins": {
    "nightshift": {
      "schedule": {
        "processingHours": {
          "start": "23:00",
          "end": "06:00"
        },
        "goodNightBufferMinutes": 45
      }
    }
  }
}
```

### Schedule

| Setting | Default | What It Does |
|---|---|---|
| `processingHours.start` | `"22:30"` | Clock time that starts the processing window (overnight) |
| `processingHours.end` | `"05:00"` | Clock time that ends it |
| `processingHours.timezone` | `"America/Los_Angeles"` | Timezone for the clock-based window |
| `goodNightBufferMinutes` | `30` | Minutes to wait after a bedtime phrase before starting tasks |
| `userActiveThresholdMinutes` | `5` | Minutes of silence before user is considered inactive |

### Triggers

| Setting | Default | What It Does |
|---|---|---|
| `goodNightPhrases` | `["good night", "goodnight", "heading to bed", ...]` | Phrases that start office hours early |
| `morningPhrases` | `["good morning", "morning", "im back", ...]` | Phrases that end office hours immediately |

### Processing

| Setting | Default | What It Does |
|---|---|---|
| `cycleIntervalMs` | `60000` | Milliseconds between task processing cycles |
| `maxCyclesPerNight` | `10` | Maximum tasks processed in one night |
| `pauseOnUserActivity` | `true` | Pause current task when user sends a message |
| `resumeAfterMinutes` | `5` | Minutes of inactivity before resuming paused tasks |

### Tasks

| Setting | Default | What It Does |
|---|---|---|
| `contemplation.enabled` | `true` | Enable contemplative inquiry tasks |
| `contemplation.priority` | `50` | Queue priority (higher = runs first) |
| `contemplation.maxPerNight` | `3` | Max contemplation tasks per night |
| `crystallization.enabled` | `true` | Enable trait crystallization tasks |
| `crystallization.priority` | `25` | Queue priority |
| `crystallization.maxPerNight` | `2` | Max crystallization tasks per night |
| `metabolismBatch.enabled` | `true` | Enable metabolism batch processing |
| `metabolismBatch.priority` | `10` | Queue priority |
| `metabolismBatch.maxPerNight` | `5` | Max metabolism batches per night |

### State

| Setting | Default | What It Does |
|---|---|---|
| `persistPath` | `"state.json"` | Filename for persisted state (relative to plugin data dir) |
| `logPath` | `"nightshift.log"` | Filename for nightshift logs |

## Gateway Methods

### `nightshift.getState`

Returns the current state for an agent. Useful for dashboards or debugging.

```json
{
  "method": "nightshift.getState",
  "params": { "agentId": "main" }
}
```

Returns: `isInOfficeHours`, `isUserActive`, `isProcessing`, `currentTask`, `queuedTasks` (count), `cyclesThisNight`, `goodNightTime`, `lastUserActivity`, `timezone`.

### `nightshift.queueTask`

Queue a task via the gateway (for external integrations or manual triggering).

```json
{
  "method": "nightshift.queueTask",
  "params": {
    "agentId": "main",
    "task": { "type": "contemplation", "priority": 50 }
  }
}
```

Returns: `taskId`, `queued: true`.

### `nightshift.setTimezone`

Update the timezone for an agent's schedule.

```json
{
  "method": "nightshift.setTimezone",
  "params": { "agentId": "main", "timezone": "America/New_York" }
}
```

## Part of the Meta-Cognitive Suite

Nightshift is one of six OpenClaw plugins that work together to give an agent self-awareness, memory, and autonomous growth:

1. **[openclaw-plugin-stability](https://github.com/CoderofTheWest/openclaw-plugin-stability)** — Entropy monitoring, drift detection, anti-hallucination
2. **[openclaw-plugin-continuity](https://github.com/CoderofTheWest/openclaw-plugin-continuity)** — Persistent memory, context budgeting, semantic search
3. **[openclaw-plugin-metabolism](https://github.com/CoderofTheWest/openclaw-plugin-metabolism)** — Entropy-triggered conversation processing and implication extraction
4. **[openclaw-plugin-nightshift](https://github.com/CoderofTheWest/openclaw-plugin-nightshift)** — Off-hours task scheduling and queue management *(this plugin)*
5. **[openclaw-plugin-contemplation](https://github.com/CoderofTheWest/openclaw-plugin-contemplation)** — Self-directed contemplative inquiry from knowledge gaps
6. **[openclaw-plugin-crystallization](https://github.com/CoderofTheWest/openclaw-plugin-crystallization)** — Trait crystallization from long-standing growth vectors

Each plugin is independent and useful on its own. Together they form a complete cognitive architecture.

See [openclaw-metacognitive-suite](https://github.com/CoderofTheWest/openclaw-metacognitive-suite) for the full picture.

## License

MIT
