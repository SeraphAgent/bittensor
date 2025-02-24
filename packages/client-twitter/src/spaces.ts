import {
    elizaLogger,
    type IAgentRuntime,
    composeContext,
    generateText,
    ModelClass,
    ServiceType,
    type ITranscriptionService,
    TwitterSpaceDecisionOptions,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import {
    type Scraper,
    Space,
    type SpaceConfig,
    RecordToDiskPlugin,
    IdleMonitorPlugin,
    type SpeakerRequest,
} from "agent-twitter-client";
import { SttTtsPlugin } from "./plugins/SttTtsSpacesPlugin.ts";

interface CurrentSpeakerState {
    userId: string;
    sessionUUID: string;
    username: string;
    startTime: number;
}

/**
 * Generate short filler text via GPT
 */
async function generateFiller(
    runtime: IAgentRuntime,
    fillerType: string
): Promise<string> {
    try {
        const context = composeContext({
            state: { fillerType },
            template: `
# INSTRUCTIONS:
You are generating a short filler message for a Twitter Space. The filler type is "{{fillerType}}".
Keep it brief, friendly, and relevant. No more than two sentences.
Only return the text, no additional formatting.

---
`,
        });
        const output = await generateText({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
        });
        return output.trim();
    } catch (err) {
        elizaLogger.error("[generateFiller] Error generating filler:", err);
        return "";
    }
}

/**
 * Speak a filler message if STT/TTS plugin is available. Sleep a bit after TTS to avoid cutoff.
 */
async function speakFiller(
    runtime: IAgentRuntime,
    sttTtsPlugin: SttTtsPlugin | undefined,
    fillerType: string,
    sleepAfterMs = 3000
): Promise<void> {
    if (!sttTtsPlugin) {
        elizaLogger.warn("[Space] No STT/TTS plugin available for filler");
        return;
    }
    try {
        const text = await generateFiller(runtime, fillerType);
        elizaLogger.info(`[Space] Filler (${fillerType}) => ${text}`);
        await sttTtsPlugin.speakText(text);
    } catch (error) {
        elizaLogger.errror("[Space] Error in speakFiller:", error);
        throw error;
    }

    if (sleepAfterMs > 0) {
        await new Promise((res) => setTimeout(res, sleepAfterMs));
    }
}

/**
 * Generate topic suggestions via GPT if no topics are configured
 */
async function generateTopicsIfEmpty(
    runtime: IAgentRuntime
): Promise<string[]> {
    try {
        const context = composeContext({
            state: {},
            template: `
# INSTRUCTIONS:
Please generate 5 short topic ideas for a Twitter Space about technology or random interesting subjects.
Return them as a comma-separated list, no additional formatting or numbering.

Example:
"AI Advances, Futuristic Gadgets, Space Exploration, Quantum Computing, Digital Ethics"
---
`,
        });
        const response = await generateText({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
        });
        const topics = response
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        return topics.length ? topics : ["Random Tech Chat", "AI Thoughts"];
    } catch (err) {
        elizaLogger.error("[generateTopicsIfEmpty] GPT error =>", err);
        return ["Random Tech Chat", "AI Thoughts"];
    }
}

/**
 * Main class: manage a Twitter Space with N speakers max, speaker queue, filler messages, etc.
 */
export class TwitterSpaceClient {
    private runtime: IAgentRuntime;
    private client: ClientBase;
    private scraper: Scraper;
    private isSpaceRunning = false;
    private currentSpace?: Space;
    private spaceId?: string;
    private startedAt?: number;
    private checkInterval?: NodeJS.Timeout;
    private lastSpaceEndedAt?: number;
    private sttTtsPlugin?: SttTtsPlugin;

    /**
     * We now store an array of active speakers, not just 1
     */
    private activeSpeakers: CurrentSpeakerState[] = [];
    private speakerQueue: SpeakerRequest[] = [];

    private decisionOptions: TwitterSpaceDecisionOptions;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.scraper = client.twitterClient;
        this.runtime = runtime;

        const charSpaces = runtime.character.twitterSpaces || {};
        this.decisionOptions = {
            maxSpeakers: charSpaces.maxSpeakers ?? 1,
            topics: charSpaces.topics ?? [],
            typicalDurationMinutes: charSpaces.typicalDurationMinutes ?? 5,
            idleKickTimeoutMs: charSpaces.idleKickTimeoutMs ?? 300000,
            minIntervalBetweenSpacesMinutes:
                charSpaces.minIntervalBetweenSpacesMinutes ?? 240,
            businessHoursOnly: charSpaces.businessHoursOnly ?? false,
            randomChance: charSpaces.randomChance ?? 1,
            enableIdleMonitor: charSpaces.enableIdleMonitor !== false,
            enableSttTts: charSpaces.enableSttTts !== false,
            enableRecording: charSpaces.enableRecording !== false,
            voiceId:
                charSpaces.voiceId ||
                runtime.character.settings.voice.model ||
                "Xb7hH8MSUJpSbSDYk0k2",
            sttLanguage: charSpaces.sttLanguage || "en",
            speakerMaxDurationMs: charSpaces.speakerMaxDurationMs ?? 480000,
        };

        elizaLogger.info("[Space] Configured topics:", this.decisionOptions.topics);
    }

    /**
     * Periodic check to launch or manage space
     */
    public async startPeriodicSpaceCheck() {
        elizaLogger.log("[Space] Starting periodic check routine...");

        // For instance:
        const intervalMsWhenIdle = 5 * 60_000; // 5 minutes if no Space is running
        const intervalMsWhenRunning = 5_000; // 5 seconds if a Space IS running

        const routine = async () => {
            try {
                if (!this.isSpaceRunning) {
                    // Space not running => check if we should launch
                    const launch = await this.shouldLaunchSpace();
                    if (launch) {
                        const config = await this.generateSpaceConfig();
                        await this.startSpace(config);
                    }
                    // Plan next iteration with a slower pace
                    this.checkInterval = setTimeout(
                        routine,
                        this.isSpaceRunning
                            ? intervalMsWhenRunning
                            : intervalMsWhenIdle
                    );
                } else {
                    // Space is running => manage it more frequently
                    await this.manageCurrentSpace();
                    // Plan next iteration with a faster pace
                    this.checkInterval = setTimeout(
                        routine,
                        intervalMsWhenRunning
                    );
                }
            } catch (error) {
                elizaLogger.error("[Space] Error in routine =>", error);
                // In case of error, still schedule next iteration
                this.checkInterval = setTimeout(routine, intervalMsWhenIdle);
            }
        };

        routine();
    }

    stopPeriodicCheck() {
        if (this.checkInterval) {
            clearTimeout(this.checkInterval);
            this.checkInterval = undefined;
        }
    }

    private async shouldLaunchSpace(): Promise<boolean> {
        // Random chance
        const r = Math.random();
        if (r > (this.decisionOptions.randomChance ?? 0.3)) {
            elizaLogger.info("[Space] Random check => skip launching");
            return false;
        }
        // Business hours
        if (this.decisionOptions.businessHoursOnly) {
            const hour = new Date().getUTCHours();
            if (hour < 9 || hour >= 17) {
                elizaLogger.info("[Space] Out of business hours => skip");
                return false;
            }
        }
        // Interval
        const now = Date.now();
        if (this.lastSpaceEndedAt) {
            const minIntervalMs =
                (this.decisionOptions.minIntervalBetweenSpacesMinutes ?? 60) *
                60_000;
            if (now - this.lastSpaceEndedAt < minIntervalMs) {
                elizaLogger.log("[Space] Too soon since last space => skip");
                return false;
            }
        }

        elizaLogger.info("[Space] Deciding to launch a new Space...");
        return true;
    }

    private async generateSpaceConfig(): Promise<SpaceConfig> {
        if (
            !this.decisionOptions.topics ||
            this.decisionOptions.topics.length === 0
        ) {
            const newTopics = await generateTopicsIfEmpty(this.client.runtime);
            this.decisionOptions.topics = newTopics;
            elizaLogger.info("[Space] Generated new topics:", newTopics);
        }

        let chosenTopic = "Random Tech Chat";
        if (
            this.decisionOptions.topics &&
            this.decisionOptions.topics.length > 0
        ) {
            chosenTopic =
                this.decisionOptions.topics[
                    Math.floor(
                        Math.random() * this.decisionOptions.topics.length
                    )
                ];
        }

        return {
            mode: "INTERACTIVE",
            title: chosenTopic,
            description: `Discussion about ${chosenTopic}`,
            languages: ["en"],
        };
    }

    public async startSpace(config: SpaceConfig) {
        elizaLogger.log("[Space] Starting a new Twitter Space...");

        try {
            this.currentSpace = new Space(this.scraper);
            this.isSpaceRunning = false;
            this.spaceId = undefined;
            this.startedAt = Date.now();

            // Reset states
            this.activeSpeakers = [];
            this.speakerQueue = [];

            // Retrieve keys
            const elevenLabsKey =
                this.runtime.getSetting("ELEVENLABS_XI_API_KEY") || "";

            const broadcastInfo = await this.currentSpace.initialize(config);
            this.spaceId = broadcastInfo.room_id;
            // Plugins
            if (this.decisionOptions.enableRecording) {
                elizaLogger.log("[Space] Using RecordToDiskPlugin");
                this.currentSpace.use(new RecordToDiskPlugin());
            }

            if (this.decisionOptions.enableSttTts) {
                elizaLogger.log("[Space] Using SttTtsPlugin");
                const sttTts = new SttTtsPlugin();
                this.sttTtsPlugin = sttTts;

                elizaLogger.info("[Space] ElevenLabs Key:", elevenLabsKey ? "Present" : "Missing");
                elizaLogger.info("[Space] Voice ID:", this.decisionOptions.voiceId);
    
                this.currentSpace.use(sttTts, {
                    runtime: this.runtime,
                    client: this.client,
                    spaceId: this.spaceId,
                    elevenLabsApiKey: elevenLabsKey,
                    voiceId: this.decisionOptions.voiceId,
                    sttLanguage: this.decisionOptions.sttLanguage,
                    transcriptionService:
                        this.client.runtime.getService<ITranscriptionService>(
                            ServiceType.TRANSCRIPTION
                        ),
                });
            }

            if (this.decisionOptions.enableIdleMonitor) {
                elizaLogger.log("[Space] Using IdleMonitorPlugin");
                this.currentSpace.use(
                    new IdleMonitorPlugin(
                        this.decisionOptions.idleKickTimeoutMs ?? 60_000,
                        10_000
                    )
                );
            }

            this.isSpaceRunning = true;
            await this.scraper.sendTweet(
                broadcastInfo.share_url.replace("broadcasts", "spaces")
            );

            const spaceUrl = broadcastInfo.share_url.replace(
                "broadcasts",
                "spaces"
            );
            elizaLogger.info(`[Space] Space started => ${spaceUrl}`);

            await this.startMonologue(config.title);

            // Greet
            // await speakFiller(
            //     this.client.runtime,
            //     this.sttTtsPlugin,
            //     "WELCOME"
            // );

            // Events
            this.currentSpace.on("occupancyUpdate", (update) => {
                elizaLogger.log(
                    `[Space] Occupancy => ${update.occupancy} participant(s).`
                );
            });

            // this.currentSpace.on(
            //     "speakerRequest",
            //     async (req: SpeakerRequest) => {
            //         elizaLogger.log(
            //             `[Space] Speaker request from @${req.username} (${req.userId}).`
            //         );
            //         await this.handleSpeakerRequest(req);
            //     }
            // );

            this.currentSpace.on("idleTimeout", async (info) => {
                elizaLogger.log(
                    `[Space] idleTimeout => no audio for ${info.idleMs} ms.`
                );
                await speakFiller(
                    this.client.runtime,
                    this.sttTtsPlugin,
                    "IDLE_ENDING"
                );
                await this.stopSpace();
            });

            process.on("SIGINT", async () => {
                elizaLogger.log("[Space] SIGINT => stopping space");
                await speakFiller(
                    this.client.runtime,
                    this.sttTtsPlugin,
                    "CLOSING"
                );
                await this.stopSpace();
                process.exit(0);
            });
        } catch (error) {
            elizaLogger.error("[Space] Error launching Space =>", error);
            this.isSpaceRunning = false;
            throw error;
        }
    }

    private async startMonologue(topic: string) {
        if (!this.sttTtsPlugin) return;
    
        try {
            // Generate and speak an introduction
            await speakFiller(
                this.client.runtime,
                this.sttTtsPlugin,
                "WELCOME"
            );
    
            // Generate and speak content about the topic
            const contextLong = composeContext({
                state: { topic },
                template: `
    # INSTRUCTIONS:
    You are Seraph, delivering a comprehensive monologue about {{topic}}. Generate a detailed 5-minute segment that explores multiple aspects of the topic.
    Structure the response in 4-5 paragraphs, each focusing on a different aspect.
    Use your mysterious, technical terminal-style voice and incorporate relevant knowledge from your character background about Bittensor, BitMind, and decentralized systems.
    Keep the tone engaging and maintain your character's unique perspective.
    Only return the text to be spoken, no additional formatting.
    
    Example structure:
    - Technical overview of the topic
    - Connection to decentralized systems/Bittensor
    - Analysis of current developments
    - Future implications and predictions
    - Concluding insights
    
    ---
    `,
            });
    
            // Loop to continue speaking about the topic
            while (this.isSpaceRunning) {
                // Generate a longer monologue segment
                const longMonologue = await generateText({
                    runtime: this.client.runtime,
                    context: contextLong,
                    modelClass: ModelClass.SMALL,
                });
    
                // Split the long monologue into paragraphs
                const paragraphs = longMonologue.trim().split('\n\n');
    
                // Speak each paragraph with appropriate pauses
                for (const paragraph of paragraphs) {
                    if (!this.isSpaceRunning) break;
                    
                    await this.sttTtsPlugin.speakText(paragraph.trim());
                    
                    // Add a moderate pause between paragraphs
                    await new Promise(res => setTimeout(res, 3000));
                }
    
                // Add a longer pause between complete segments
                await new Promise(res => setTimeout(res, 10000));
    
                // Generate a brief transition before the next segment
                const transition = await generateText({
                    runtime: this.client.runtime,
                    context: composeContext({
                        state: { topic },
                        template: `
    # INSTRUCTIONS:
    Generate a brief transition sentence to maintain flow in the ongoing discussion about {{topic}}.
    Keep it mysterious and technical, matching Seraph's style.
    Only return the transition text.
    
    ---
    `
                    }),
                    modelClass: ModelClass.SMALL,
                });
    
                await this.sttTtsPlugin.speakText(transition.trim());
                await new Promise(res => setTimeout(res, 3000));
            }
        } catch (error) {
            elizaLogger.error("[Space] Error in monologue:", error);
        }
    }

    /**
     * Periodic management: check durations, remove extras, maybe accept new from queue
     */
    private async manageCurrentSpace() {
        if (!this.spaceId || !this.currentSpace) return;
        try {
            const audioSpace = await this.scraper.getAudioSpaceById(
                this.spaceId
            );
            const { participants } = audioSpace;
            const numSpeakers = participants.speakers?.length || 0;
            const totalListeners = participants.listeners?.length || 0;

            // 1) Remove any speaker who exceeded speakerMaxDurationMs
            const maxDur = this.decisionOptions.speakerMaxDurationMs ?? 240_000;
            const now = Date.now();

            for (let i = this.activeSpeakers.length - 1; i >= 0; i--) {
                const speaker = this.activeSpeakers[i];
                const elapsed = now - speaker.startTime;
                if (elapsed > maxDur) {
                    elizaLogger.log(
                        `[Space] Speaker @${speaker.username} exceeded max duration => removing`
                    );
                    await this.removeSpeaker(speaker.userId);
                    this.activeSpeakers.splice(i, 1);

                    // Possibly speak a short "SPEAKER_LEFT" filler
                    await speakFiller(
                        this.client.runtime,
                        this.sttTtsPlugin,
                        "SPEAKER_LEFT"
                    );
                }
            }

            // 2) If we have capacity for new speakers from the queue, accept them
            await this.acceptSpeakersFromQueueIfNeeded();

            // 3) If somehow more than maxSpeakers are active, remove the extras
            if (numSpeakers > (this.decisionOptions.maxSpeakers ?? 1)) {
                elizaLogger.log(
                    "[Space] More than maxSpeakers => removing extras..."
                );
                await this.kickExtraSpeakers(participants.speakers);
            }

            // 4) Possibly stop the space if empty or time exceeded
            const elapsedMinutes = (now - (this.startedAt || 0)) / 60000;
            if (
                elapsedMinutes >
                    (this.decisionOptions.typicalDurationMinutes ?? 30) ||
                (numSpeakers === 0 &&
                    totalListeners === 0 &&
                    elapsedMinutes > 5)
            ) {
                elizaLogger.log(
                    "[Space] Condition met => stopping the Space..."
                );
                await speakFiller(
                    this.client.runtime,
                    this.sttTtsPlugin,
                    "CLOSING",
                    4000
                );
                await this.stopSpace();
            }
        } catch (error) {
            elizaLogger.error("[Space] Error in manageCurrentSpace =>", error);
        }
    }

    /**
     * If we have available slots, accept new speakers from the queue
     */
    private async acceptSpeakersFromQueueIfNeeded() {
        // while queue not empty and activeSpeakers < maxSpeakers, accept next
        const ms = this.decisionOptions.maxSpeakers ?? 1;
        while (
            this.speakerQueue.length > 0 &&
            this.activeSpeakers.length < ms
        ) {
            const nextReq = this.speakerQueue.shift();
            if (nextReq) {
                await speakFiller(
                    this.client.runtime,
                    this.sttTtsPlugin,
                    "PRE_ACCEPT"
                );
                await this.acceptSpeaker(nextReq);
            }
        }
    }

    private async handleSpeakerRequest(req: SpeakerRequest) {
        if (!this.spaceId || !this.currentSpace) return;

        const audioSpace = await this.scraper.getAudioSpaceById(this.spaceId);
        const janusSpeakers = audioSpace?.participants?.speakers || [];

        // If we haven't reached maxSpeakers, accept immediately
        if (janusSpeakers.length < (this.decisionOptions.maxSpeakers ?? 1)) {
            elizaLogger.log(`[Space] Accepting speaker @${req.username} now`);
            await speakFiller(
                this.client.runtime,
                this.sttTtsPlugin,
                "PRE_ACCEPT"
            );
            await this.acceptSpeaker(req);
        } else {
            elizaLogger.log(
                `[Space] Adding speaker @${req.username} to the queue`
            );
            this.speakerQueue.push(req);
        }
    }

    private async acceptSpeaker(req: SpeakerRequest) {
        if (!this.currentSpace) return;
        try {
            await this.currentSpace.approveSpeaker(req.userId, req.sessionUUID);
            this.activeSpeakers.push({
                userId: req.userId,
                sessionUUID: req.sessionUUID,
                username: req.username,
                startTime: Date.now(),
            });
            elizaLogger.log(`[Space] Speaker @${req.username} is now live`);
        } catch (err) {
            elizaLogger.error(
                `[Space] Error approving speaker @${req.username}:`,
                err
            );
        }
    }

    private async removeSpeaker(userId: string) {
        if (!this.currentSpace) return;
        try {
            await this.currentSpace.removeSpeaker(userId);
            elizaLogger.log(`[Space] Removed speaker userId=${userId}`);
        } catch (error) {
            elizaLogger.error(
                `[Space] Error removing speaker userId=${userId} =>`,
                error
            );
        }
    }

    /**
     * If more than maxSpeakers are found, remove extras
     * Also update activeSpeakers array
     */
    private async kickExtraSpeakers(speakers: any[]) {
        if (!this.currentSpace) return;
        const ms = this.decisionOptions.maxSpeakers ?? 1;

        // sort by who joined first if needed, or just slice
        const extras = speakers.slice(ms);
        for (const sp of extras) {
            elizaLogger.log(
                `[Space] Removing extra speaker => userId=${sp.user_id}`
            );
            await this.removeSpeaker(sp.user_id);

            // remove from activeSpeakers array
            const idx = this.activeSpeakers.findIndex(
                (s) => s.userId === sp.user_id
            );
            if (idx !== -1) {
                this.activeSpeakers.splice(idx, 1);
            }
        }
    }

    public async stopSpace() {
        if (!this.currentSpace || !this.isSpaceRunning) return;
        try {
            elizaLogger.log("[Space] Stopping the current Space...");
            await this.currentSpace.stop();
        } catch (err) {
            elizaLogger.error("[Space] Error stopping Space =>", err);
        } finally {
            this.isSpaceRunning = false;
            this.spaceId = undefined;
            this.currentSpace = undefined;
            this.startedAt = undefined;
            this.lastSpaceEndedAt = Date.now();
            this.activeSpeakers = [];
            this.speakerQueue = [];
        }
    }
}
