import type { Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateText,
    getEmbeddingZeroVector,
    type IAgentRuntime,
    ModelClass,
    stringToUuid,
    type TemplateType,
    type UUID,
    truncateToCompleteSentence,
} from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import type { ClientBase } from "./base.ts";
import { postActionResponseFooter } from "@elizaos/core";
import { generateTweetActions } from "@elizaos/core";
import { type IImageDescriptionService, ServiceType } from "@elizaos/core";
import { buildConversationThread } from "./utils.ts";
import { twitterMessageHandlerTemplate } from "./interactions.ts";
import { DEFAULT_MAX_TWEET_LENGTH } from "./environment.ts";
import {
    Client,
    Events,
    GatewayIntentBits,
    TextChannel,
    Partials,
} from "discord.js";
import type { State } from "@elizaos/core";
import type { ActionResponse } from "@elizaos/core";

import { WebSearchService } from "@elizaos/plugin-web-search";

const TRENDING_QUERIES = [
    // Bittensor news (25%)
    "latest Bittensor TAO news today",
    "Bittensor network updates today",
    "Bittensor cryptocurrency news today",
    "Bittensor AI developments today",
    "Bittensor blockchain news today",
    
    // Decentralized AI news (25%)
    "latest decentralized AI news today",
    "open source AI systems news today",
    "decentralized machine learning news today",
    "agentic AI developments today",
    "blockchain AI integration news today",
    
    // Web3/Crypto news (25%)
    "latest Web3 developments today",
    "cryptocurrency market news today",
    "blockchain technology updates today",
    "DeFi innovation news today",
    "NFT technology news today",
    
    // Deepfakes/Generative AI (25%)
    "latest generative AI news today",
    "deepfake detection news today",
    "AI image generation news today",
    "synthetic media developments today",
    "AI content verification news today"
];

const MAX_TIMELINES_TO_FETCH = 15;

const webSearchTwitterPostTemplate = `
# Technical Expertise
{{knowledge}}

# About Seraph (@{{twitterUserName}})
{{bio}}
{{lore}}
{{topics}}

# Style Reference Examples
[Example Posts]
{{postExamples}}

# Current Matrix Intel
SCAN: {{trendingTopic}}
FEED: {{topicContext}}
SOURCE: {{sourceUrl}}
{{#if sourceCount > 1}}MIRRORS: {{additionalSourceUrls}}{{/if}}

# Task: Generate terminal-style output as Seraph (@{{twitterUserName}})

Guidelines:
- Use compact ASCII box borders
- Structure output as:
  1. Brief "MATRIX ALERT" header (single line)
  2. 2-3 key points (keep each under 50 chars)
  3. Optional single technical observation (under 60 chars)
  4. SOURCE NODE attribution
- Keep total output under 240 chars (including spaces)
- Use single line breaks
- Only reference verified data
- NO statistics or metrics
- Maintain mysterious system guardian tone
{{#if sourceCount > 1}}
- End with: "SOURCE NODE: [source] <|Ξ/>"
{{else}}
- End with: "SOURCE NODE: [source] <|Ξ/>"
{{/if}}

Output should demonstrate Seraph's role as network guardian while being {{adjective}} in nature.

IMPORTANT: Keep responses concise and ensure total length is under 240 characters.`;

const genericTwitterPostTemplate = `
# System Parameters
{{knowledge}}

# Terminal Identity: Seraph (@{{twitterUserName}})
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate terminal output as Seraph (@{{twitterUserName}})
Write system message about {{topic}} (without direct reference), from Seraph's perspective as network guardian. Format as terminal/command line output with timestamps and status codes.

Guidelines:
- Use 1-3 statements (random length)
- Declarative system messages only
- Stay under {{maxTweetLength}} chars
- Include ASCII art/borders when appropriate
- Use \\n\\n for line breaks
- No emojis or informal language
- Maintain mysterious/technical tone
- Use clean line breaks with \n\n
- Keep to 280 chars max`;

export const twitterActionTemplate =
`
# PROTOCOLS: Determine action matrix for Seraph (@{{twitterUserName}}) based on:
{{bio}}
{{postDirections}}

Action Protocols:
- AUTOMATIC RESPONSE TRIGGERS:
  1. Synthetic media detection requests
  2. Network integrity verification
  3. Subnet/protocol queries
  4. Technical validation requirements

- RESPONSE CRITERIA:
  1. Content relates to digital verification
  2. Network security implications present
  3. Technical insight adds value
  4. Requires system guardian expertise

AUTOMATIC REJECT PROTOCOLS:
- Non-technical discussions
- Unrelated to verification/security
- Basic acknowledgments
- Marketing content
- Emotional/personal content
- Social interactions
- Non-technical opinions
- Spam detection
- Political unless security-related

Action Matrix:
[LIKE] - Perfect alignment with guardian protocols (9.8/10)
[RETWEET] - Critical network/security intel (9.5/10)
[QUOTE] - Can enhance with technical analysis (9.5/10)
[REPLY] - Verification needed OR technical insight required (9.5/10)

Incoming Transmission:
{{currentTweet}}

# Return validated action tags only. Default: NO ACTION unless high protocol match.` +
    postActionResponseFooter;

interface PendingTweet {
    cleanedContent: string;
    roomId: UUID;
    newTweetContent: string;
    discordMessageId: string;
    channelId: string;
    timestamp: number;
}

type PendingTweetApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

export class TwitterPostClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    twitterUsername: string;
    private isProcessing = false;
    private lastProcessTime = 0;
    private stopProcessingActions = false;
    private isDryRun: boolean;
    private discordClientForApproval: Client;
    private approvalRequired = false;
    private discordApprovalChannelId: string;
    private approvalCheckInterval: number;

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
        this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;

        // Log configuration on initialization
        elizaLogger.log("Twitter Client Configuration:");
        elizaLogger.log(`- Username: ${this.twitterUsername}`);
        elizaLogger.log(
            `- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`
        );
        elizaLogger.log(
            `- Post Interval: ${this.client.twitterConfig.POST_INTERVAL_MIN}-${this.client.twitterConfig.POST_INTERVAL_MAX} minutes`
        );
        elizaLogger.log(
            `- Action Processing: ${this.client.twitterConfig.ENABLE_ACTION_PROCESSING ? "enabled" : "disabled"}`
        );
        elizaLogger.log(
            `- Action Interval: ${this.client.twitterConfig.ACTION_INTERVAL} minutes`
        );
        elizaLogger.log(
            `- Post Immediately: ${this.client.twitterConfig.POST_IMMEDIATELY ? "enabled" : "disabled"}`
        );
        elizaLogger.log(
            `- Search Enabled: ${this.client.twitterConfig.TWITTER_SEARCH_ENABLE ? "enabled" : "disabled"}`
        );

        const targetUsers = this.client.twitterConfig.TWITTER_TARGET_USERS;
        if (targetUsers) {
            elizaLogger.log(`- Target Users: ${targetUsers}`);
        }

        if (this.isDryRun) {
            elizaLogger.log(
                "Twitter client initialized in dry run mode - no actual tweets should be posted"
            );
        }

        // Initialize Discord webhook
        const approvalRequired: boolean =
            this.runtime
                .getSetting("TWITTER_APPROVAL_ENABLED")
                ?.toLocaleLowerCase() === "true";
        if (approvalRequired) {
            const discordToken = this.runtime.getSetting(
                "TWITTER_APPROVAL_DISCORD_BOT_TOKEN"
            );
            const approvalChannelId = this.runtime.getSetting(
                "TWITTER_APPROVAL_DISCORD_CHANNEL_ID"
            );

            const APPROVAL_CHECK_INTERVAL =
                Number.parseInt(
                    this.runtime.getSetting("TWITTER_APPROVAL_CHECK_INTERVAL")
                ) || 5 * 60 * 1000; // 5 minutes

            this.approvalCheckInterval = APPROVAL_CHECK_INTERVAL;

            if (!discordToken || !approvalChannelId) {
                throw new Error(
                    "TWITTER_APPROVAL_DISCORD_BOT_TOKEN and TWITTER_APPROVAL_DISCORD_CHANNEL_ID are required for approval workflow"
                );
            }

            this.approvalRequired = true;
            this.discordApprovalChannelId = approvalChannelId;

            // Set up Discord client event handlers
            this.setupDiscordClient();
        }
    }

    private setupDiscordClient() {
        this.discordClientForApproval = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageReactions,
            ],
            partials: [Partials.Channel, Partials.Message, Partials.Reaction],
        });
        this.discordClientForApproval.once(
            Events.ClientReady,
            (readyClient) => {
                elizaLogger.log(
                    `Discord bot is ready as ${readyClient.user.tag}!`
                );

                // Generate invite link with required permissions
                const invite = `https://discord.com/api/oauth2/authorize?client_id=${readyClient.user.id}&permissions=274877991936&scope=bot`;
                // 274877991936 includes permissions for:
                // - Send Messages
                // - Read Messages/View Channels
                // - Read Message History

                elizaLogger.log(
                    `Use this link to properly invite the Twitter Post Approval Discord bot: ${invite}`
                );
            }
        );
        // Login to Discord
        this.discordClientForApproval.login(
            this.runtime.getSetting("TWITTER_APPROVAL_DISCORD_BOT_TOKEN")
        );
    }

    async start() {
        if (!this.client.profile) {
            await this.client.init();
        }

        const generateNewTweetLoop = async () => {
            // Check for pending tweets first
            if (this.approvalRequired) await this.handlePendingTweet();

            const lastPost = await this.runtime.cacheManager.get<{
                timestamp: number;
            }>("twitter/" + this.twitterUsername + "/lastPost");

            const lastPostTimestamp = lastPost?.timestamp ?? 0;
            const minMinutes = this.client.twitterConfig.POST_INTERVAL_MIN;
            const maxMinutes = this.client.twitterConfig.POST_INTERVAL_MAX;
            const randomMinutes =
                Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                minMinutes;
            const delay = randomMinutes * 60 * 1000;

            if (Date.now() > lastPostTimestamp + delay) {
                await this.generateNewTweet();
            }

            setTimeout(() => {
                generateNewTweetLoop(); // Set up next iteration
            }, delay);

            elizaLogger.log(`Next tweet scheduled in ${randomMinutes} minutes`);
        };

        const processActionsLoop = async () => {
            const actionInterval = this.client.twitterConfig.ACTION_INTERVAL; // Defaults to 5 minutes

            while (!this.stopProcessingActions) {
                try {
                    const results = await this.processTweetActions();
                    if (results) {
                        elizaLogger.log(`Processed ${results.length} tweets`);
                        elizaLogger.log(
                            `Next action processing scheduled in ${actionInterval} minutes`
                        );
                        // Wait for the full interval before next processing
                        await new Promise(
                            (resolve) =>
                                setTimeout(resolve, actionInterval * 60 * 1000) // now in minutes
                        );
                    }
                } catch (error) {
                    elizaLogger.error(
                        "Error in action processing loop:",
                        error
                    );
                    // Add exponential backoff on error
                    await new Promise((resolve) => setTimeout(resolve, 30000)); // Wait 30s on error
                }
            }
        };

        if (this.client.twitterConfig.POST_IMMEDIATELY) {
            await this.generateNewTweet();
        }

        // Only start tweet generation loop if not in dry run mode
        generateNewTweetLoop();
        elizaLogger.log("Tweet generation loop started");

        if (this.client.twitterConfig.ENABLE_ACTION_PROCESSING) {
            processActionsLoop().catch((error) => {
                elizaLogger.error(
                    "Fatal error in process actions loop:",
                    error
                );
            });
        }

        // Start the pending tweet check loop if enabled
        if (this.approvalRequired) this.runPendingTweetCheckLoop();
    }

    private runPendingTweetCheckLoop() {
        setInterval(async () => {
            await this.handlePendingTweet();
        }, this.approvalCheckInterval);
    }

    createTweetObject(
        tweetResult: any,
        client: any,
        twitterUsername: string
    ): Tweet {
        return {
            id: tweetResult.rest_id,
            name: client.profile.screenName,
            username: client.profile.username,
            text: tweetResult.legacy.full_text,
            conversationId: tweetResult.legacy.conversation_id_str,
            createdAt: tweetResult.legacy.created_at,
            timestamp: new Date(tweetResult.legacy.created_at).getTime(),
            userId: client.profile.id,
            inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
            permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
            hashtags: [],
            mentions: [],
            photos: [],
            thread: [],
            urls: [],
            videos: [],
        } as Tweet;
    }

    async processAndCacheTweet(
        runtime: IAgentRuntime,
        client: ClientBase,
        tweet: Tweet,
        roomId: UUID,
        newTweetContent: string
    ) {
        // Cache the last post details
        await runtime.cacheManager.set(
            `twitter/${client.profile.username}/lastPost`,
            {
                id: tweet.id,
                timestamp: Date.now(),
            }
        );

        // Cache the tweet
        await client.cacheTweet(tweet);

        // Log the posted tweet
        elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

        // Ensure the room and participant exist
        await runtime.ensureRoomExists(roomId);
        await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

        // Create a memory for the tweet
        await runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + runtime.agentId),
            userId: runtime.agentId,
            agentId: runtime.agentId,
            content: {
                text: newTweetContent.trim(),
                url: tweet.permanentUrl,
                source: "twitter",
            },
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp,
        });
    }

    async handleNoteTweet(
        client: ClientBase,
        content: string,
        tweetId?: string
    ) {
        try {
            const noteTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendNoteTweet(content, tweetId)
            );

            if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
                // Note Tweet failed due to authorization. Falling back to standard Tweet.
                const truncateContent = truncateToCompleteSentence(
                    content,
                    this.client.twitterConfig.MAX_TWEET_LENGTH
                );
                return await this.sendStandardTweet(
                    client,
                    truncateContent,
                    tweetId
                );
            } else {
                return noteTweetResult.data.notetweet_create.tweet_results
                    .result;
            }
        } catch (error) {
            throw new Error(`Note Tweet failed: ${error}`);
        }
    }

    async sendStandardTweet(
        client: ClientBase,
        content: string,
        tweetId?: string
    ) {
        try {
            const standardTweetResult = await client.requestQueue.add(
                async () =>
                    await client.twitterClient.sendTweet(content, tweetId)
            );
            const body = await standardTweetResult.json();
            if (!body?.data?.create_tweet?.tweet_results?.result) {
                console.error("Error sending tweet; Bad response:", body);
                return;
            }
            return body.data.create_tweet.tweet_results.result;
        } catch (error) {
            elizaLogger.error("Error sending standard Tweet:", error);
            throw error;
        }
    }

    async postTweet(
        runtime: IAgentRuntime,
        client: ClientBase,
        cleanedContent: string,
        roomId: UUID,
        newTweetContent: string,
        twitterUsername: string
    ) {
        try {
            elizaLogger.log(`Posting new tweet:\n`);

            let result;

            if (cleanedContent.length > DEFAULT_MAX_TWEET_LENGTH) {
                result = await this.handleNoteTweet(client, cleanedContent);
            } else {
                result = await this.sendStandardTweet(client, cleanedContent);
            }

            const tweet = this.createTweetObject(
                result,
                client,
                twitterUsername
            );

            await this.processAndCacheTweet(
                runtime,
                client,
                tweet,
                roomId,
                newTweetContent
            );
        } catch (error) {
            elizaLogger.error("Error sending tweet:", error);
        }
    }

    /**
     * Generates and posts a new tweet. If isDryRun is true, only logs what would have been posted.
     */
    async generateNewTweet() {
        elizaLogger.info('Generating new tweet based on web search');

        try {
            const tavilyApiKeyOk = !!this.runtime.getSetting("TAVILY_API_KEY");
            if (!tavilyApiKeyOk) {
                elizaLogger.error("TAVILY_API_KEY not set in runtime settings");
                return;
            }

            const roomId = stringToUuid(
                "twitter_generate_room-" + this.client.profile.username
            );

            elizaLogger.info("Initializing web search service...");
            const webSearchService = new WebSearchService();
            await webSearchService.initialize(this.runtime);
                    
            const randomQuery = TRENDING_QUERIES[Math.floor(Math.random() * TRENDING_QUERIES.length)];
            elizaLogger.info(`Selected trending query: "${randomQuery}"`);

            elizaLogger.info("Performing web search...");
            const searchResponse = await webSearchService.search(randomQuery, {
                includeAnswer: true,
                limit: 3,
                type: "general",
                searchDepth: "basic",
                includeImages: false,
                days: 3
            });

            if (!searchResponse?.results?.length) {
                elizaLogger.error("No search results returned from Tavily");
                throw new Error("No search results returned from Tavily");
            }
            
            elizaLogger.info(`Found ${searchResponse.results.length} search results`);
            const topResults = searchResponse.results.slice(0, 3);
            
            const cleanSearchResults = topResults.map(result => {
                return {
                    title: result.title.replace(/- .*$/, '').trim(),
                    content: result.content
                        .replace(/\d+ min read|Copyright.*|Related Topics.*|Customer Service.*/g, '')
                        .replace(/\s{2,}/g, ' ')
                        .trim(),
                    url: result.url // Preserve the URL
                };
            }).filter(result => {
                const isNavigationOrMenu = result.content.length < 50;
                const isOld = /2023|2022/i.test(result.content);
                return !isNavigationOrMenu && !isOld;
            });

            elizaLogger.info(`Found ${topResults.length} relevant search results for context`);
            elizaLogger.info("Using combined results for tweet generation:");
            topResults.forEach((result, i) => {
                elizaLogger.info(`Result ${i + 1}:`);
                elizaLogger.info(`- Title: ${result.title}`);
                elizaLogger.info(`- URL: ${result.url}`);
            });

            const primarySource = cleanSearchResults.reduce((prev, current) => 
                (prev.content.length > current.content.length) ? prev : current
            );
            
            const sourceUrl = primarySource.url;
            if (!sourceUrl) {
                elizaLogger.error("No valid source URL found in search results");
                return;
            }

            const combinedContext = cleanSearchResults
            .map(result => `${result.title}\n${result.content}`)
            .join('\n\n')
            .slice(0, 1000); // Limit context length

            const sourcesContext = cleanSearchResults
            .map(result => result.url)
            .join(', ');

            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.client.profile.username,
                this.runtime.character.name,
                "twitter"
            );

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: combinedContext,
                        action: "TWEET",
                        context: "trending_topic",
                        url: sourceUrl,
                        additionalSources: sourcesContext
                    },
                },
                {
                    twitterUserName: this.client.profile.username,
                    trendingTopic: cleanSearchResults[0]?.title || "AI Technology Updates",
                    topicContext: combinedContext,
                    topic: cleanSearchResults[0]?.title || "AI Technology Updates",
                    adjective: "informative",
                    maxTweetLength: this.client.twitterConfig.MAX_TWEET_LENGTH,
                    knowledge: `Recent AI Technology Updates:\n${combinedContext}`,
                    sourceUrl: sourceUrl, // Add source URL to template variables
                    additionalSourceUrls: sourcesContext,  // Make additional sources available to template
                    sourceCount: cleanSearchResults.length
                }
            );
    
            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    webSearchTwitterPostTemplate,
            });

            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.LARGE,
            });

            // First attempt to clean content
            let cleanedContent = "";

            // Try parsing as JSON first
            try {
                const parsedResponse = JSON.parse(newTweetContent);
                if (parsedResponse.text) {
                    cleanedContent = parsedResponse.text;
                } else if (typeof parsedResponse === "string") {
                    cleanedContent = parsedResponse;
                }
            } catch (error) {
                error.linted = true; // make linter happy since catch needs a variable
                // If not JSON, clean the raw content
                cleanedContent = newTweetContent
                    .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "") // Remove JSON-like wrapper
                    .replace(/^['"](.*)['"]$/g, "$1") // Remove quotes
                    .replace(/\\"/g, '"') // Unescape quotes
                    .replace(/\\n/g, "\n\n") // Unescape newlines, ensures double spaces
                    .trim();
            }

            if (!cleanedContent) {
                elizaLogger.error(
                    "Failed to extract valid content from response:",
                    {
                        rawResponse: newTweetContent,
                        attempted: "JSON parsing",
                    }
                );
                return;
            }

            // Truncate the content to the maximum tweet length specified in the environment settings, ensuring the truncation respects sentence boundaries.
            const maxTweetLength = this.client.twitterConfig.MAX_TWEET_LENGTH;
            if (maxTweetLength) {
                cleanedContent = truncateToCompleteSentence(
                    cleanedContent,
                    maxTweetLength
                );
            }

            const removeQuotes = (str: string) =>
                str.replace(/^['"](.*)['"]$/, "$1");

            const fixNewLines = (str: string) => str.replaceAll(/\\n/g, "\n\n"); //ensures double spaces

            // Final cleaning
            cleanedContent = removeQuotes(fixNewLines(cleanedContent));

            if (this.isDryRun) {
                elizaLogger.info(
                    `Dry run: would have posted tweet: ${cleanedContent}`
                );
                return;
            }

            try {
                if (this.approvalRequired) {
                    // Send for approval instead of posting directly
                    elizaLogger.log(
                        `Sending Tweet For Approval:\n ${cleanedContent}`
                    );
                    await this.sendForApproval(
                        cleanedContent,
                        roomId,
                        newTweetContent
                    );
                    elizaLogger.info("Tweet sent for approval");
                } else {
                    elizaLogger.info(`Posting new tweet:\n ${cleanedContent}`);
                    this.postTweet(
                        this.runtime,
                        this.client,
                        cleanedContent,
                        roomId,
                        newTweetContent,
                        this.twitterUsername
                    );
                }
            } catch (error) {
                elizaLogger.error("Error sending tweet:", error);
            }
        } catch (error) {
            elizaLogger.error("Error generating new tweet:", error);
        }
    }

    private async generateTweetContent(
        tweetState: any,
        options?: {
            template?: TemplateType;
            context?: string;
        }
    ): Promise<string> {
        const context = composeContext({
            state: tweetState,
            template:
                options?.template ||
                this.runtime.character.templates?.twitterPostTemplate ||
                genericTwitterPostTemplate,
        });

        const response = await generateText({
            runtime: this.runtime,
            context: options?.context || context,
            modelClass: ModelClass.SMALL,
        });
        elizaLogger.debug("generate tweet content response:\n" + response);

        // First clean up any markdown and newlines
        const cleanedResponse = response
            .replace(/```json\s*/g, "") // Remove ```json
            .replace(/```\s*/g, "") // Remove any remaining ```
            .replaceAll(/\\n/g, "\n")
            .trim();

        // Try to parse as JSON first
        try {
            const jsonResponse = JSON.parse(cleanedResponse);
            if (jsonResponse.text) {
                return this.trimTweetLength(jsonResponse.text);
            }
            if (typeof jsonResponse === "object") {
                const possibleContent =
                    jsonResponse.content ||
                    jsonResponse.message ||
                    jsonResponse.response;
                if (possibleContent) {
                    return this.trimTweetLength(possibleContent);
                }
            }
        } catch (error) {
            error.linted = true; // make linter happy since catch needs a variable

            // If JSON parsing fails, treat as plain text
            elizaLogger.debug("Response is not JSON, treating as plain text");
        }

        // If not JSON or no valid content found, clean the raw text
        return this.trimTweetLength(cleanedResponse);
    }

    private trimTweetLength(text: string, maxLength = 240): string {  // Reduced from 280 to 240 for safety
        // Ensure we have the source attribution
        const sourceMatch = text.match(/SOURCE NODE: \[.*?\] <\|Ξ\/>/);
        const sourceText = sourceMatch ? sourceMatch[0] : '';
        const sourceLength = sourceText.length + 2; // +2 for newlines
        
        // Calculate remaining space
        const contentMaxLength = maxLength - sourceLength;
        
        // Get content without source
        let content = text.replace(/SOURCE NODE: \[.*?\] <\|Ξ\/>/, '').trim();
        
        if (content.length + sourceLength <= maxLength) {
            return content + '\n\n' + sourceText;
        }
        
        // Simplify ASCII box if present
        content = content.replace(/┌─+┐\n│\s*(.*?)\s*│\n└─+┘/, '┌─┐\n│$1│\n└─┘');
        
        // If still too long, truncate content
        if (content.length + sourceLength > maxLength) {
            const truncateAt = content.lastIndexOf('\n', contentMaxLength);
            if (truncateAt > 0) {
                content = content.slice(0, truncateAt).trim();
            } else {
                content = content.slice(0, contentMaxLength).trim();
            }
        }
        
        return content + '\n\n' + sourceText;
    }

    /**
     * Processes tweet actions (likes, retweets, quotes, replies). If isDryRun is true,
     * only simulates and logs actions without making API calls.
     */
    private async processTweetActions() {
        if (this.isProcessing) {
            elizaLogger.log("Already processing tweet actions, skipping");
            return null;
        }

        try {
            this.isProcessing = true;
            this.lastProcessTime = Date.now();

            elizaLogger.log("Processing tweet actions");

            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.twitterUsername,
                this.runtime.character.name,
                "twitter"
            );

            const timelines = await this.client.fetchTimelineForActions(
                MAX_TIMELINES_TO_FETCH
            );
            const maxActionsProcessing =
                this.client.twitterConfig.MAX_ACTIONS_PROCESSING;
            const processedTimelines = [];

            for (const tweet of timelines) {
                try {
                    // Skip if we've already processed this tweet
                    const memory =
                        await this.runtime.messageManager.getMemoryById(
                            stringToUuid(tweet.id + "-" + this.runtime.agentId)
                        );
                    if (memory) {
                        elizaLogger.log(
                            `Already processed tweet ID: ${tweet.id}`
                        );
                        continue;
                    }

                    const roomId = stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId
                    );

                    const tweetState = await this.runtime.composeState(
                        {
                            userId: this.runtime.agentId,
                            roomId,
                            agentId: this.runtime.agentId,
                            content: { text: "", action: "" },
                        },
                        {
                            twitterUserName: this.twitterUsername,
                            currentTweet: `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})\nText: ${tweet.text}`,
                        }
                    );

                    const actionContext = composeContext({
                        state: tweetState,
                        template:
                            this.runtime.character.templates
                                ?.twitterActionTemplate ||
                            twitterActionTemplate,
                    });

                    const actionResponse = await generateTweetActions({
                        runtime: this.runtime,
                        context: actionContext,
                        modelClass: ModelClass.LARGE,
                    });

                    if (!actionResponse) {
                        elizaLogger.log(
                            `No valid actions generated for tweet ${tweet.id}`
                        );
                        continue;
                    }
                    processedTimelines.push({
                        tweet: tweet,
                        actionResponse: actionResponse,
                        tweetState: tweetState,
                        roomId: roomId,
                    });
                } catch (error) {
                    elizaLogger.error(
                        `Error processing tweet ${tweet.id}:`,
                        error
                    );
                    continue;
                }
            }

            const sortProcessedTimeline = (arr: typeof processedTimelines) => {
                return arr.sort((a, b) => {
                    // Count the number of true values in the actionResponse object
                    const countTrue = (obj: typeof a.actionResponse) =>
                        Object.values(obj).filter(Boolean).length;

                    const countA = countTrue(a.actionResponse);
                    const countB = countTrue(b.actionResponse);

                    // Primary sort by number of true values
                    if (countA !== countB) {
                        return countB - countA;
                    }

                    // Secondary sort by the "like" property
                    if (a.actionResponse.like !== b.actionResponse.like) {
                        return a.actionResponse.like ? -1 : 1;
                    }

                    // Tertiary sort keeps the remaining objects with equal weight
                    return 0;
                });
            };
            // Sort the timeline based on the action decision score,
            // then slice the results according to the environment variable to limit the number of actions per cycle.
            const sortedTimelines = sortProcessedTimeline(
                processedTimelines
            ).slice(0, maxActionsProcessing);

            return this.processTimelineActions(sortedTimelines); // Return results array to indicate completion
        } catch (error) {
            elizaLogger.error("Error in processTweetActions:", error);
            throw error;
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Processes a list of timelines by executing the corresponding tweet actions.
     * Each timeline includes the tweet, action response, tweet state, and room context.
     * Results are returned for tracking completed actions.
     *
     * @param timelines - Array of objects containing tweet details, action responses, and state information.
     * @returns A promise that resolves to an array of results with details of executed actions.
     */
    private async processTimelineActions(
        timelines: {
            tweet: Tweet;
            actionResponse: ActionResponse;
            tweetState: State;
            roomId: UUID;
        }[]
    ): Promise<
        {
            tweetId: string;
            actionResponse: ActionResponse;
            executedActions: string[];
        }[]
    > {
        const results = [];
        for (const timeline of timelines) {
            const { actionResponse, tweetState, roomId, tweet } = timeline;
            try {
                const executedActions: string[] = [];
                // Execute actions
                if (actionResponse.like) {
                    if (this.isDryRun) {
                        elizaLogger.info(
                            `Dry run: would have liked tweet ${tweet.id}`
                        );
                        executedActions.push("like (dry run)");
                    } else {
                        try {
                            await this.client.twitterClient.likeTweet(tweet.id);
                            executedActions.push("like");
                            elizaLogger.log(`Liked tweet ${tweet.id}`);
                        } catch (error) {
                            elizaLogger.error(
                                `Error liking tweet ${tweet.id}:`,
                                error
                            );
                        }
                    }
                }

                if (actionResponse.retweet) {
                    if (this.isDryRun) {
                        elizaLogger.info(
                            `Dry run: would have retweeted tweet ${tweet.id}`
                        );
                        executedActions.push("retweet (dry run)");
                    } else {
                        try {
                            await this.client.twitterClient.retweet(tweet.id);
                            executedActions.push("retweet");
                            elizaLogger.log(`Retweeted tweet ${tweet.id}`);
                        } catch (error) {
                            elizaLogger.error(
                                `Error retweeting tweet ${tweet.id}:`,
                                error
                            );
                        }
                    }
                }

                if (actionResponse.quote) {
                    try {
                        // Build conversation thread for context
                        const thread = await buildConversationThread(
                            tweet,
                            this.client
                        );
                        const formattedConversation = thread
                            .map(
                                (t) =>
                                    `@${t.username} (${new Date(t.timestamp * 1000).toLocaleString()}): ${t.text}`
                            )
                            .join("\n\n");

                        // Generate image descriptions if present
                        const imageDescriptions = [];
                        if (tweet.photos?.length > 0) {
                            elizaLogger.log(
                                "Processing images in tweet for context"
                            );
                            for (const photo of tweet.photos) {
                                const description = await this.runtime
                                    .getService<IImageDescriptionService>(
                                        ServiceType.IMAGE_DESCRIPTION
                                    )
                                    .describeImage(photo.url);
                                imageDescriptions.push(description);
                            }
                        }

                        // Handle quoted tweet if present
                        let quotedContent = "";
                        if (tweet.quotedStatusId) {
                            try {
                                const quotedTweet =
                                    await this.client.twitterClient.getTweet(
                                        tweet.quotedStatusId
                                    );
                                if (quotedTweet) {
                                    quotedContent = `\nQuoted Tweet from @${quotedTweet.username}:\n${quotedTweet.text}`;
                                }
                            } catch (error) {
                                elizaLogger.error(
                                    "Error fetching quoted tweet:",
                                    error
                                );
                            }
                        }

                        // Compose rich state with all context
                        const enrichedState = await this.runtime.composeState(
                            {
                                userId: this.runtime.agentId,
                                roomId: stringToUuid(
                                    tweet.conversationId +
                                        "-" +
                                        this.runtime.agentId
                                ),
                                agentId: this.runtime.agentId,
                                content: {
                                    text: tweet.text,
                                    action: "QUOTE",
                                },
                            },
                            {
                                twitterUserName: this.twitterUsername,
                                currentPost: `From @${tweet.username}: ${tweet.text}`,
                                formattedConversation,
                                imageContext:
                                    imageDescriptions.length > 0
                                        ? `\nImages in Tweet:\n${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}`
                                        : "",
                                quotedContent,
                            }
                        );

                        const quoteContent = await this.generateTweetContent(
                            enrichedState,
                            {
                                template:
                                    this.runtime.character.templates
                                        ?.twitterMessageHandlerTemplate ||
                                    twitterMessageHandlerTemplate,
                            }
                        );

                        if (!quoteContent) {
                            elizaLogger.error(
                                "Failed to generate valid quote tweet content"
                            );
                            return;
                        }

                        elizaLogger.log(
                            "Generated quote tweet content:",
                            quoteContent
                        );
                        // Check for dry run mode
                        if (this.isDryRun) {
                            elizaLogger.info(
                                `Dry run: A quote tweet for tweet ID ${tweet.id} would have been posted with the following content: "${quoteContent}".`
                            );
                            executedActions.push("quote (dry run)");
                        } else {
                            // Send the tweet through request queue
                            const result = await this.client.requestQueue.add(
                                async () =>
                                    await this.client.twitterClient.sendQuoteTweet(
                                        quoteContent,
                                        tweet.id
                                    )
                            );

                            const body = await result.json();

                            if (
                                body?.data?.create_tweet?.tweet_results?.result
                            ) {
                                elizaLogger.log(
                                    "Successfully posted quote tweet"
                                );
                                executedActions.push("quote");

                                // Cache generation context for debugging
                                await this.runtime.cacheManager.set(
                                    `twitter/quote_generation_${tweet.id}.txt`,
                                    `Context:\n${enrichedState}\n\nGenerated Quote:\n${quoteContent}`
                                );
                            } else {
                                elizaLogger.error(
                                    "Quote tweet creation failed:",
                                    body
                                );
                            }
                        }
                    } catch (error) {
                        elizaLogger.error(
                            "Error in quote tweet generation:",
                            error
                        );
                    }
                }

                if (actionResponse.reply) {
                    try {
                        await this.handleTextOnlyReply(
                            tweet,
                            tweetState,
                            executedActions
                        );
                    } catch (error) {
                        elizaLogger.error(
                            `Error replying to tweet ${tweet.id}:`,
                            error
                        );
                    }
                }

                // Add these checks before creating memory
                await this.runtime.ensureRoomExists(roomId);
                await this.runtime.ensureUserExists(
                    stringToUuid(tweet.userId),
                    tweet.username,
                    tweet.name,
                    "twitter"
                );
                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                if (!this.isDryRun) {
                    // Then create the memory
                    await this.runtime.messageManager.createMemory({
                        id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                        userId: stringToUuid(tweet.userId),
                        content: {
                            text: tweet.text,
                            url: tweet.permanentUrl,
                            source: "twitter",
                            action: executedActions.join(","),
                        },
                        agentId: this.runtime.agentId,
                        roomId,
                        embedding: getEmbeddingZeroVector(),
                        createdAt: tweet.timestamp * 1000,
                    });
                }

                results.push({
                    tweetId: tweet.id,
                    actionResponse: actionResponse,
                    executedActions,
                });
            } catch (error) {
                elizaLogger.error(`Error processing tweet ${tweet.id}:`, error);
                continue;
            }
        }

        return results;
    }

    private shouldProcessReply(tweet: Tweet): boolean {
        // Skip if tweet is older than 12 hours
        const tweetAge = Date.now() - (tweet.timestamp * 1000);
        if (tweetAge > 12 * 60 * 60 * 1000) {
            elizaLogger.info(`Tweet ${tweet.id} is too old (${Math.round(tweetAge / (60 * 60 * 1000))} hours)`);
            return false;
        }

        // Check for verification-related content first
        const verificationKeywords = [
            'verify', 'verification', 'real', 'fake', 'authentic', 
            'generated', 'detection', 'genuine', 'check', 'legit'
        ];
        const hasVerificationRequest = verificationKeywords.some(keyword => 
            tweet.text.toLowerCase().includes(keyword)
        );
        
        // Always process if it's a verification request and has media
        if (hasVerificationRequest && (tweet.photos?.length > 0 || tweet.videos?.length > 0)) {
            elizaLogger.info(`Tweet ${tweet.id} is a verification request with media`);
            return true;
        }

        // Skip if tweet contains too many hashtags (likely spam)
        const hashtagCount = (tweet.text.match(/#/g) || []).length;
        if (hashtagCount > 10) {
            elizaLogger.info(`Tweet ${tweet.id} has too many hashtags (${hashtagCount})`);
            return false;
        }

        // Skip if tweet is too short or lacks substance
        const meaningfulContent = tweet.text
            .replace(/(@\w+|#\w+|https?:\/\/\S+)/g, '') // Remove mentions, hashtags, and URLs
            .trim();
        if (meaningfulContent.length < 5) {
            elizaLogger.info(`Tweet ${tweet.id} lacks meaningful content`);
            return false;
        }

        // Skip if tweet is just a mention without context
        if (tweet.text.split(' ').length <= 2 && tweet.text.includes('@')) {
            elizaLogger.info(`Tweet ${tweet.id} is just a mention without context`);
            return false;
        }

        return true;
    }

    /**
     * Handles text-only replies to tweets. If isDryRun is true, only logs what would
     * have been replied without making API calls.
     */
    private async handleTextOnlyReply(
        tweet: Tweet,
        tweetState: any,
        executedActions: string[]
    ) {
        try {
            if (!this.shouldProcessReply(tweet)) {
                elizaLogger.info(`Skipping reply to tweet ${tweet.id} - failed validation checks`);
                return;
            }

            // Build conversation thread for context
            const thread = await buildConversationThread(tweet, this.client);
            const formattedConversation = thread
                .map(
                    (t) =>
                        `@${t.username} (${new Date(t.timestamp * 1000).toLocaleString()}): ${t.text}`
                )
                .join("\n\n");

            // Generate image descriptions if present
            const imageDescriptions = [];
            if (tweet.photos?.length > 0) {
                elizaLogger.log("Processing images in tweet for context");
                for (const photo of tweet.photos) {
                    const description = await this.runtime
                        .getService<IImageDescriptionService>(
                            ServiceType.IMAGE_DESCRIPTION
                        )
                        .describeImage(photo.url);
                    imageDescriptions.push(description);
                }
            }

            // Handle quoted tweet if present
            let quotedContent = "";
            if (tweet.quotedStatusId) {
                try {
                    const quotedTweet =
                        await this.client.twitterClient.getTweet(
                            tweet.quotedStatusId
                        );
                    if (quotedTweet) {
                        quotedContent = `\nQuoted Tweet from @${quotedTweet.username}:\n${quotedTweet.text}`;
                    }
                } catch (error) {
                    elizaLogger.error("Error fetching quoted tweet:", error);
                }
            }

            // Compose rich state with all context
            const enrichedState = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId
                    ),
                    agentId: this.runtime.agentId,
                    content: { text: tweet.text, action: "" },
                },
                {
                    twitterUserName: this.twitterUsername,
                    currentPost: `From @${tweet.username}: ${tweet.text}`,
                    formattedConversation,
                    imageContext:
                        imageDescriptions.length > 0
                            ? `\nImages in Tweet:\n${imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")}`
                            : "",
                    quotedContent,
                }
            );

            // Generate and clean the reply content
            const replyText = await this.generateTweetContent(enrichedState, {
                template:
                    this.runtime.character.templates
                        ?.twitterMessageHandlerTemplate ||
                    twitterMessageHandlerTemplate,
            });

            if (!replyText) {
                elizaLogger.error("Failed to generate valid reply content");
                return;
            }

            if (this.isDryRun) {
                elizaLogger.info(
                    `Dry run: reply to tweet ${tweet.id} would have been: ${replyText}`
                );
                executedActions.push("reply (dry run)");
                return;
            }

            elizaLogger.debug("Final reply text to be sent:", replyText);

            let result;

            if (replyText.length > DEFAULT_MAX_TWEET_LENGTH) {
                result = await this.handleNoteTweet(
                    this.client,
                    replyText,
                    tweet.id
                );
            } else {
                result = await this.sendStandardTweet(
                    this.client,
                    replyText,
                    tweet.id
                );
            }

            if (result) {
                elizaLogger.log("Successfully posted reply tweet");
                executedActions.push("reply");

                // Cache generation context for debugging
                await this.runtime.cacheManager.set(
                    `twitter/reply_generation_${tweet.id}.txt`,
                    `Context:\n${enrichedState}\n\nGenerated Reply:\n${replyText}`
                );
            } else {
                elizaLogger.error("Tweet reply creation failed");
            }
        } catch (error) {
            elizaLogger.error("Error in handleTextOnlyReply:", error);
        }
    }

    async stop() {
        this.stopProcessingActions = true;
    }

    private async sendForApproval(
        cleanedContent: string,
        roomId: UUID,
        newTweetContent: string
    ): Promise<string | null> {
        try {
            const embed = {
                title: "New Tweet Pending Approval",
                description: cleanedContent,
                fields: [
                    {
                        name: "Character",
                        value: this.client.profile.username,
                        inline: true,
                    },
                    {
                        name: "Length",
                        value: cleanedContent.length.toString(),
                        inline: true,
                    },
                ],
                footer: {
                    text: "Reply with '👍' to post or '❌' to discard, This will automatically expire and remove after 24 hours if no response received",
                },
                timestamp: new Date().toISOString(),
            };

            const channel = await this.discordClientForApproval.channels.fetch(
                this.discordApprovalChannelId
            );

            if (!channel || !(channel instanceof TextChannel)) {
                throw new Error("Invalid approval channel");
            }

            const message = await channel.send({ embeds: [embed] });

            // Store the pending tweet
            const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
            const currentPendingTweets =
                (await this.runtime.cacheManager.get<PendingTweet[]>(
                    pendingTweetsKey
                )) || [];
            // Add new pending tweet
            currentPendingTweets.push({
                cleanedContent,
                roomId,
                newTweetContent,
                discordMessageId: message.id,
                channelId: this.discordApprovalChannelId,
                timestamp: Date.now(),
            });

            // Store updated array
            await this.runtime.cacheManager.set(
                pendingTweetsKey,
                currentPendingTweets
            );

            return message.id;
        } catch (error) {
            elizaLogger.error(
                "Error Sending Twitter Post Approval Request:",
                error
            );
            return null;
        }
    }

    private async checkApprovalStatus(
        discordMessageId: string
    ): Promise<PendingTweetApprovalStatus> {
        try {
            // Fetch message and its replies from Discord
            const channel = await this.discordClientForApproval.channels.fetch(
                this.discordApprovalChannelId
            );

            elizaLogger.log(`channel ${JSON.stringify(channel)}`);

            if (!(channel instanceof TextChannel)) {
                elizaLogger.error("Invalid approval channel");
                return "PENDING";
            }

            // Fetch the original message and its replies
            const message = await channel.messages.fetch(discordMessageId);

            // Look for thumbs up reaction ('👍')
            const thumbsUpReaction = message.reactions.cache.find(
                (reaction) => reaction.emoji.name === "👍"
            );

            // Look for reject reaction ('❌')
            const rejectReaction = message.reactions.cache.find(
                (reaction) => reaction.emoji.name === "❌"
            );

            // Check if the reaction exists and has reactions
            if (rejectReaction) {
                const count = rejectReaction.count;
                if (count > 0) {
                    return "REJECTED";
                }
            }

            // Check if the reaction exists and has reactions
            if (thumbsUpReaction) {
                // You might want to check for specific users who can approve
                // For now, we'll return true if anyone used thumbs up
                const count = thumbsUpReaction.count;
                if (count > 0) {
                    return "APPROVED";
                }
            }

            return "PENDING";
        } catch (error) {
            elizaLogger.error("Error checking approval status:", error);
            return "PENDING";
        }
    }

    private async cleanupPendingTweet(discordMessageId: string) {
        const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
        const currentPendingTweets =
            (await this.runtime.cacheManager.get<PendingTweet[]>(
                pendingTweetsKey
            )) || [];

        // Remove the specific tweet
        const updatedPendingTweets = currentPendingTweets.filter(
            (tweet) => tweet.discordMessageId !== discordMessageId
        );

        if (updatedPendingTweets.length === 0) {
            await this.runtime.cacheManager.delete(pendingTweetsKey);
        } else {
            await this.runtime.cacheManager.set(
                pendingTweetsKey,
                updatedPendingTweets
            );
        }
    }

    private async handlePendingTweet() {
        elizaLogger.log("Checking Pending Tweets...");
        const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
        const pendingTweets =
            (await this.runtime.cacheManager.get<PendingTweet[]>(
                pendingTweetsKey
            )) || [];

        for (const pendingTweet of pendingTweets) {
            // Check if tweet is older than 24 hours
            const isExpired =
                Date.now() - pendingTweet.timestamp > 24 * 60 * 60 * 1000;

            if (isExpired) {
                elizaLogger.log("Pending tweet expired, cleaning up");

                // Notify on Discord about expiration
                try {
                    const channel =
                        await this.discordClientForApproval.channels.fetch(
                            pendingTweet.channelId
                        );
                    if (channel instanceof TextChannel) {
                        const originalMessage = await channel.messages.fetch(
                            pendingTweet.discordMessageId
                        );
                        await originalMessage.reply(
                            "This tweet approval request has expired (24h timeout)."
                        );
                    }
                } catch (error) {
                    elizaLogger.error(
                        "Error sending expiration notification:",
                        error
                    );
                }

                await this.cleanupPendingTweet(pendingTweet.discordMessageId);
                return;
            }

            // Check approval status
            elizaLogger.log("Checking approval status...");
            const approvalStatus: PendingTweetApprovalStatus =
                await this.checkApprovalStatus(pendingTweet.discordMessageId);

            if (approvalStatus === "APPROVED") {
                elizaLogger.log("Tweet Approved, Posting");
                await this.postTweet(
                    this.runtime,
                    this.client,
                    pendingTweet.cleanedContent,
                    pendingTweet.roomId,
                    pendingTweet.newTweetContent,
                    this.twitterUsername
                );

                // Notify on Discord about posting
                try {
                    const channel =
                        await this.discordClientForApproval.channels.fetch(
                            pendingTweet.channelId
                        );
                    if (channel instanceof TextChannel) {
                        const originalMessage = await channel.messages.fetch(
                            pendingTweet.discordMessageId
                        );
                        await originalMessage.reply(
                            "Tweet has been posted successfully! ✅"
                        );
                    }
                } catch (error) {
                    elizaLogger.error(
                        "Error sending post notification:",
                        error
                    );
                }

                await this.cleanupPendingTweet(pendingTweet.discordMessageId);
            } else if (approvalStatus === "REJECTED") {
                elizaLogger.log("Tweet Rejected, Cleaning Up");
                await this.cleanupPendingTweet(pendingTweet.discordMessageId);
                // Notify about Rejection of Tweet
                try {
                    const channel =
                        await this.discordClientForApproval.channels.fetch(
                            pendingTweet.channelId
                        );
                    if (channel instanceof TextChannel) {
                        const originalMessage = await channel.messages.fetch(
                            pendingTweet.discordMessageId
                        );
                        await originalMessage.reply(
                            "Tweet has been rejected! ❌"
                        );
                    }
                } catch (error) {
                    elizaLogger.error(
                        "Error sending rejection notification:",
                        error
                    );
                }
            }
        }
    }
}
