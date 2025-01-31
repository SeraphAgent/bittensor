import { Plugin } from "@elizaos/core";
import { TwitterClientInterface } from "@elizaos/client-twitter";
import {
    type IVerifiableInferenceAdapter,
    type VerifiableInferenceOptions, 
    type VerifiableInferenceResult,
    VerifiableInferenceProvider,
    ModelProviderName,
    models,
    elizaLogger,
} from "@elizaos/core";
import OpenAI from "openai";
import { verifyProof } from "./utils/api";
import { generateProof as generateProofAction } from "./actions/proofGenerator";
import { verifyProof as verifyProofAction } from "./actions/proofVerifier";

interface OpacityOptions {
    modelProvider?: ModelProviderName;
    token?: string;
    teamId?: string;
    teamName?: string;
    opacityProverUrl: string;
    siteUrl?: string;
    siteName?: string;
}

export class OpacityAdapter implements IVerifiableInferenceAdapter {
    public options: OpacityOptions;
    private openaiClient?: OpenAI;

    constructor(options: OpacityOptions) {
        this.options = options;
    }

    async generateText(
        context: string,
        modelClass: string,
        options?: VerifiableInferenceOptions
    ): Promise<VerifiableInferenceResult> {
        const provider = this.options.modelProvider || ModelProviderName.OPENAI;
        const model = models[provider].model[modelClass];
        const apiKey = this.options.token;

        elizaLogger.log("Generating text with options:", {
            modelProvider: provider,
            model: modelClass,
        });

        // Get provider-specific endpoint and configuration
        let endpoint;
        let authHeader;
        let useOpenAISDK = false;

        switch (provider) {
            case ModelProviderName.OPENAI:
                const baseEndpoint = options?.endpoint ||
                    `https://gateway.ai.cloudflare.com/v1/${this.options.teamId}/${this.options.teamName}`;
                endpoint = `${baseEndpoint}/openai/chat/completions`;
                authHeader = `Bearer ${apiKey}`;
                break;
            case ModelProviderName.OPENROUTER:
                endpoint = "https://openrouter.ai/api/v1/chat/completions";
                authHeader = `Bearer ${apiKey}`;
                useOpenAISDK = true;
                // Initialize OpenAI client if not already done
                if (!this.openaiClient) {
                    this.openaiClient = new OpenAI({
                        baseURL: "https://openrouter.ai/api/v1",
                        apiKey: this.options.token,
                        defaultHeaders: {
                            "HTTP-Referer": this.options.siteUrl || "",
                            "X-Title": this.options.siteName || "",
                        }
                    });
                }
                break;
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }

        try {
            let response;
            let responseId;
            let responseJson;
            // Handle different API formats
            if (useOpenAISDK && this.openaiClient) {
                // OpenRouter path using OpenAI SDK
                const completion = await this.openaiClient.chat.completions.create({
                    model: modelClass,
                    messages: [
                        {
                            role: "system",
                            content: context,
                        },
                    ],
                    temperature: model.temperature || 0.7,
                    max_tokens: model.maxOutputTokens,
                    frequency_penalty: model.frequency_penalty,
                    presence_penalty: model.presence_penalty,
                });

                responseId = `or-${completion.id}`;
                responseJson = completion;
            } else {
                // Standard fetch path for Cloudflare
                let body;
                switch (provider) {
                    case ModelProviderName.OPENAI:
                        body = {
                            model: model.name,
                            messages: [
                                {
                                    role: "system",
                                    content: context,
                                },
                            ],
                            temperature: model.temperature || 0.7,
                            max_tokens: model.maxOutputTokens,
                            frequency_penalty: model.frequency_penalty,
                            presence_penalty: model.presence_penalty,
                        };
                        break;
                    default:
                        throw new Error(`Unsupported model provider: ${provider}`);
                }

                elizaLogger.debug("Request body:", JSON.stringify(body, null, 2));
                const requestBody = JSON.stringify(body);
                const requestHeaders = {
                    "Content-Type": "application/json",
                    Authorization: authHeader,
                    ...options?.headers,
                };

                elizaLogger.debug("Making request with:", {
                    endpoint,
                    headers: {
                        ...requestHeaders,
                        Authorization: "[REDACTED]",
                    },
                });

                response = await fetch(endpoint, {
                    method: "POST",
                    headers: requestHeaders,
                    body: requestBody,
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    elizaLogger.error("API error response:", {
                        status: response.status,
                        statusText: response.statusText,
                        error: errorText,
                    });
                    throw new Error(`API request failed: ${errorText}`);
                }

                responseId = response.headers.get("cf-aig-log-id");
                responseJson = await response.json();
            }

            const proof = await this.generateProof(
                this.options.opacityProverUrl,
                responseId
            );
            elizaLogger.debug(
                "Proof generated for text generation ID:",
                responseId
            );

            return {
                text: responseJson.choices[0].message.content,
                id: responseId,
                provider: VerifiableInferenceProvider.OPACITY,
                timestamp: Date.now(),
                proof,
            };
        } catch (error) {
            console.error("Error in Opacity generateText:", error);
            throw error;
        }
    }

    async generateProof(baseUrl: string, logId: string) {
        const response = await fetch(`${baseUrl}/api/logs/${logId}`);
        elizaLogger.debug("Fetching proof for log ID:", logId);
        if (!response.ok) {
            throw new Error(`Failed to fetch proof: ${response.statusText}`);
        }
        return await response.json();
    }

    async verifyProof(result: VerifiableInferenceResult): Promise<boolean> {
        const isValid = await verifyProof(
            `${this.options.opacityProverUrl}`,
            result.id,
            result.proof
        );
        console.log("Proof is valid:", isValid.success);
        if (!isValid.success) {
            throw new Error("Proof is invalid");
        }
        return isValid.success;
    }
}

export * as actions from "./actions/index";

export const opacityPlugin: Plugin = {
    name: "opacity",
    description: "Generate and verify cryptographic proofs of autonomous agent activity using the Opacity prover network",
    actions: [
        generateProofAction,
        verifyProofAction
    ],
    clients: [TwitterClientInterface]
};

export default opacityPlugin;
