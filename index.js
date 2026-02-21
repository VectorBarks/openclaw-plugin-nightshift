/**
 * openclaw-plugin-nightshift
 *
 * Night shift scheduler for heavy processing tasks.
 * Respects user workflow by running LLM-intensive operations during off-hours.
 *
 * Features:
 * - Time-based office hours (default: 10:30pm-5:00am Pacific)
 * - "Good night" detection starts office hours early
 * - Interruptible processing (pauses on user activity)
 * - Task queue with priorities
 * - Resume after interruption
 *
 * Provides scheduling for:
 * - Contemplative inquiry (priority 50)
 * - Trait crystallization (priority 25)
 * - Metabolism batch processing (priority 10)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function loadConfig(userConfig = {}) {
    const defaultConfig = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')
    );
    return deepMerge(defaultConfig, userConfig);
}

function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(target[key] || {}, source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    return dirPath;
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

module.exports = {
    id: 'nightshift',
    name: 'Night Shift Scheduler',

    configSchema: {
        jsonSchema: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' },
                schedule: { type: 'object' },
                triggers: { type: 'object' },
                processing: { type: 'object' },
                tasks: { type: 'object' },
                state: { type: 'object' }
            }
        }
    },

    register(api) {
        const config = loadConfig(api.pluginConfig || {});

        if (!config.enabled) {
            api.logger.info('Night shift scheduler disabled via config');
            return;
        }

        const baseDataDir = ensureDir(path.join(__dirname, 'data'));

        /**
         * Per-agent state container
         */
        class AgentState {
            constructor(agentId) {
                this.agentId = agentId;
                this.dataDir = agentId === 'main' 
                    ? baseDataDir 
                    : ensureDir(path.join(baseDataDir, 'agents', agentId));

                this.statePath = path.join(this.dataDir, config.state?.persistPath || 'state.json');
                this.loadState();

                // Task queue (priority-ordered)
                this.taskQueue = [];

                // Currently running task (for resume)
                this.currentTask = null;

                // Processing state
                this.isProcessing = false;
                this.cyclesThisNight = 0;
            }

            loadState() {
                try {
                    if (fs.existsSync(this.statePath)) {
                        const raw = fs.readFileSync(this.statePath, 'utf8');
                        const saved = JSON.parse(raw);
                        this.officeHoursActive = saved.officeHoursActive || false;
                        this.goodNightTime = saved.goodNightTime || null;
                        this.lastUserActivity = saved.lastUserActivity || null;
                        this.lastMorningGreeting = saved.lastMorningGreeting || null;
                        this.processedTonight = saved.processedTonight || {};
                        this.timezone = saved.timezone || config.schedule?.defaultOfficeHours?.timezone || 'America/Los_Angeles';
                    } else {
                        this.officeHoursActive = false;
                        this.goodNightTime = null;
                        this.lastUserActivity = null;
                        this.lastMorningGreeting = null;
                        this.processedTonight = {};
                        this.timezone = config.schedule?.defaultOfficeHours?.timezone || 'America/Los_Angeles';
                    }
                } catch (e) {
                    api.logger.warn(`[NightShift:${this.agentId}] Failed to load state:`, e.message);
                    this.officeHoursActive = false;
                    this.goodNightTime = null;
                    this.lastUserActivity = null;
                    this.lastMorningGreeting = null;
                    this.processedTonight = {};
                    this.timezone = config.schedule?.defaultOfficeHours?.timezone || 'America/Los_Angeles';
                }
            }

            saveState() {
                try {
                    const state = {
                        officeHoursActive: this.officeHoursActive,
                        goodNightTime: this.goodNightTime,
                        lastUserActivity: this.lastUserActivity,
                        lastMorningGreeting: this.lastMorningGreeting,
                        processedTonight: this.processedTonight,
                        timezone: this.timezone,
                        savedAt: new Date().toISOString()
                    };
                    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
                } catch (e) {
                    api.logger.warn(`[NightShift:${this.agentId}] Failed to save state:`, e.message);
                }
            }

            /**
             * Check if currently in office hours.
             * Supports both time-based and good-night-triggered office hours.
             */
            isInOfficeHours() {
                const now = new Date();

                // Check if good night triggered office hours
                if (this.goodNightTime) {
                    const bufferMs = (config.schedule?.goodNightBufferMinutes || 30) * 60 * 1000;
                    // goodNightTime may be a string (loaded from JSON) or Date object (set in-session)
                    const gnTime = this.goodNightTime instanceof Date
                        ? this.goodNightTime
                        : new Date(this.goodNightTime);
                    if (isNaN(gnTime.getTime())) return false; // Invalid date, skip
                    const officeStart = new Date(gnTime.getTime() + bufferMs);

                    // Office hours from goodNight + buffer until 5am next day
                    const officeEnd = new Date(officeStart);
                    officeEnd.setHours(5, 0, 0, 0);
                    if (officeEnd <= officeStart) {
                        officeEnd.setDate(officeEnd.getDate() + 1);
                    }

                    // Check morning greeting to end office hours early
                    if (this.lastMorningGreeting) {
                        const morningTime = new Date(this.lastMorningGreeting);
                        if (morningTime > officeStart && morningTime < officeEnd) {
                            return false; // Morning greeting ended office hours
                        }
                    }

                    if (now >= officeStart && now < officeEnd) {
                        return true;
                    }
                }

                // Check default time-based office hours
                const defaultHours = config.schedule?.defaultOfficeHours;
                if (defaultHours) {
                    const [startHour, startMin] = defaultHours.start.split(':').map(Number);
                    const [endHour, endMin] = defaultHours.end.split(':').map(Number);

                    const currentHour = now.getHours();
                    const currentMin = now.getMinutes();
                    const currentMins = currentHour * 60 + currentMin;
                    const startMins = startHour * 60 + startMin;
                    const endMins = endHour * 60 + endMin;

                    // Handle overnight window (e.g., 22:30 - 05:00)
                    if (startMins > endMins) {
                        // Overnight: active if current >= start OR current < end
                        return currentMins >= startMins || currentMins < endMins;
                    } else {
                        // Same day: active if between start and end
                        return currentMins >= startMins && currentMins < endMins;
                    }
                }

                return false;
            }

            /**
             * Check if user has been active recently.
             */
            isUserActive() {
                if (!this.lastUserActivity) return false;
                const thresholdMs = (config.schedule?.userActiveThresholdMinutes || 5) * 60 * 1000;
                return (Date.now() - this.lastUserActivity) < thresholdMs;
            }

            /**
             * Queue a task for processing.
             */
            queueTask(task) {
                const taskWithMeta = {
                    ...task,
                    id: task.id || `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                    queued: Date.now(),
                    attempts: 0
                };

                // Insert by priority (higher priority = processed first)
                const insertIndex = this.taskQueue.findIndex(t => t.priority < taskWithMeta.priority);
                if (insertIndex === -1) {
                    this.taskQueue.push(taskWithMeta);
                } else {
                    this.taskQueue.splice(insertIndex, 0, taskWithMeta);
                }

                api.logger.info(`[NightShift:${this.agentId}] Queued task: ${taskWithMeta.id} (priority: ${taskWithMeta.priority})`);
                return taskWithMeta.id;
            }

            /**
             * Get next task to process.
             */
            getNextTask() {
                // Filter out tasks that hit max attempts
                this.taskQueue = this.taskQueue.filter(t => t.attempts < 3);
                return this.taskQueue.shift();
            }

            /**
             * Reset nightly counters (call at start of new office hours).
             */
            resetNightlyCounters() {
                this.cyclesThisNight = 0;
                this.processedTonight = {};
            }
        }

        /** @type {Map<string, AgentState>} */
        const agentStates = new Map();

        function getAgentState(agentId) {
            const id = agentId || 'main';
            if (!agentStates.has(id)) {
                agentStates.set(id, new AgentState(id));
                api.logger.info(`[NightShift] Initialized state for agent "${id}"`);
            }
            return agentStates.get(id);
        }

        /**
         * Detect "good night" phrases.
         */
        function detectGoodNight(text) {
            const lower = (text || '').toLowerCase();
            const phrases = config.triggers?.goodNightPhrases || [];
            return phrases.some(phrase => lower.includes(phrase.toLowerCase()));
        }

        /**
         * Detect "morning" phrases.
         */
        function detectMorning(text) {
            const lower = (text || '').toLowerCase();
            const phrases = config.triggers?.morningPhrases || [];
            return phrases.some(phrase => lower.includes(phrase.toLowerCase()));
        }

        /**
         * Task runners registry.
         * Other plugins can register task runners.
         */
        const taskRunners = new Map();

        function registerTaskRunner(taskType, runner) {
            taskRunners.set(taskType, runner);
            api.logger.info(`[NightShift] Registered task runner: ${taskType}`);
        }

        function getTaskRunner(taskType) {
            return taskRunners.get(taskType);
        }

        // Expose task runner registration (both scoped api and global for cross-plugin access)
        const nightshiftApi = {
            registerTaskRunner,
            getTaskRunner,
            queueTask: (agentId, task) => getAgentState(agentId).queueTask(task),
            isInOfficeHours: (agentId) => getAgentState(agentId).isInOfficeHours(),
            isUserActive: (agentId) => getAgentState(agentId).isUserActive()
        };
        api.nightshift = nightshiftApi;
        global.__ocNightshift = nightshiftApi;

        // -------------------------------------------------------------------
        // HOOK: agent_end — Detect good night / morning, track activity
        // -------------------------------------------------------------------

        api.on('agent_end', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);

            // Update last activity
            state.lastUserActivity = Date.now();

            // Check for good night / morning
            const messages = event.messages || [];
            const lastUser = [...messages].reverse().find(m => m?.role === 'user');
            const rawContent = lastUser?.content;
            // Content can be a string or an array of content blocks
            const userText = typeof rawContent === 'string'
                ? rawContent
                : Array.isArray(rawContent)
                    ? rawContent.filter(b => b?.type === 'text').map(b => b.text).join(' ')
                    : '';

            if (detectGoodNight(userText)) {
                state.goodNightTime = new Date();
                state.resetNightlyCounters();
                api.logger.info(`[NightShift:${state.agentId}] Good night detected — office hours starting in ${config.schedule?.goodNightBufferMinutes || 30} minutes`);
            }

            if (detectMorning(userText)) {
                state.lastMorningGreeting = new Date().toISOString();
                state.goodNightTime = null; // Reset good night
                api.logger.info(`[NightShift:${state.agentId}] Morning detected — office hours ended`);
            }

            state.saveState();
        });

        // -------------------------------------------------------------------
        // HOOK: heartbeat — Process tasks during office hours
        // -------------------------------------------------------------------

        api.on('heartbeat', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);

            // Check if we should process
            if (!state.isInOfficeHours()) {
                return; // Not office hours
            }

            if (state.isUserActive()) {
                return; // User is active, don't process
            }

            if (state.isProcessing) {
                return; // Already processing
            }

            const maxCycles = config.processing?.maxCyclesPerNight || 10;
            if (state.cyclesThisNight >= maxCycles) {
                return; // Hit max cycles for tonight
            }

            // Get next task
            const task = state.getNextTask();
            if (!task) {
                return; // No tasks queued
            }

            // Check task-specific limits
            const taskConfig = config.tasks?.[task.type];
            if (taskConfig?.maxPerNight) {
                const processed = state.processedTonight[task.type] || 0;
                if (processed >= taskConfig.maxPerNight) {
                    api.logger.debug(`[NightShift:${state.agentId}] Task type ${task.type} hit max per night`);
                    return;
                }
            }

            // Run the task
            state.isProcessing = true;
            state.currentTask = task;

            try {
                const runner = getTaskRunner(task.type);
                if (runner) {
                    api.logger.info(`[NightShift:${state.agentId}] Running task: ${task.id} (${task.type})`);
                    await runner(task, ctx);
                    state.processedTonight[task.type] = (state.processedTonight[task.type] || 0) + 1;
                } else {
                    api.logger.warn(`[NightShift:${state.agentId}] No runner for task type: ${task.type}`);
                }
            } catch (error) {
                api.logger.error(`[NightShift:${state.agentId}] Task failed: ${task.id}`, error.message);
                task.attempts++;
                // Re-queue if under max attempts
                if (task.attempts < 3) {
                    state.taskQueue.push(task);
                }
            } finally {
                state.isProcessing = false;
                state.currentTask = null;
                state.cyclesThisNight++;
                state.saveState();
            }
        });

        // -------------------------------------------------------------------
        // HOOK: before_agent_start — Pause processing on user activity
        // -------------------------------------------------------------------

        api.on('before_agent_start', async (event, ctx) => {
            const state = getAgentState(ctx.agentId);

            // If we're processing, pause it
            if (state.isProcessing && state.currentTask) {
                api.logger.info(`[NightShift:${state.agentId}] Pausing task for user activity: ${state.currentTask.id}`);
                // Save current task state for resume
                state.currentTask.paused = true;
                state.currentTask.pausedAt = Date.now();
                // The task runner should check for this and yield
            }

            // Update activity timestamp
            state.lastUserActivity = Date.now();
        });

        // -------------------------------------------------------------------
        // Gateway methods
        // -------------------------------------------------------------------

        api.registerGatewayMethod('nightshift.getState', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            respond(true, {
                agentId: state.agentId,
                isInOfficeHours: state.isInOfficeHours(),
                isUserActive: state.isUserActive(),
                isProcessing: state.isProcessing,
                currentTask: state.currentTask,
                queuedTasks: state.taskQueue.length,
                cyclesThisNight: state.cyclesThisNight,
                goodNightTime: state.goodNightTime,
                lastUserActivity: state.lastUserActivity,
                timezone: state.timezone
            });
        });

        api.registerGatewayMethod('nightshift.queueTask', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            const taskId = state.queueTask(params?.task || {});
            respond(true, { taskId, queued: true });
        });

        api.registerGatewayMethod('nightshift.setTimezone', async ({ params, respond }) => {
            const state = getAgentState(params?.agentId);
            state.timezone = params?.timezone || 'America/Los_Angeles';
            state.saveState();
            respond(true, { timezone: state.timezone });
        });

        api.logger.info('Night shift scheduler registered — heavy processing during off-hours only');
    }
};