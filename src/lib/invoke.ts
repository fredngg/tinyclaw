import fs from 'fs';
import path from 'path';
import { AgentConfig, TeamConfig, ConversationMessage } from './types';
import { SCRIPT_DIR, resolveOpenRouterModel } from './config';
import { log } from './logging';
import { ensureAgentDirectory, updateAgentTeammates } from './agent-setup';

// In-memory conversation history per agent (for multi-turn continuity)
const agentConversations = new Map<string, ConversationMessage[]>();

const MAX_HISTORY_MESSAGES = 40; // keep last N messages to avoid unbounded growth

/**
 * Invoke a model via OpenRouter's chat completion API.
 * Maintains per-agent conversation history for multi-turn context.
 */
async function invokeOpenRouter(
    agentId: string,
    message: string,
    modelId: string,
    shouldReset: boolean,
): Promise<string> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY environment variable is not set');
    }

    // Manage conversation history
    if (shouldReset || !agentConversations.has(agentId)) {
        agentConversations.set(agentId, []);
        if (shouldReset) {
            log('INFO', `🔄 Reset OpenRouter conversation for agent: ${agentId}`);
        }
    }

    const history = agentConversations.get(agentId)!;

    // Add user message
    history.push({ role: 'user', content: message });

    // Trim history to prevent unbounded growth
    while (history.length > MAX_HISTORY_MESSAGES) {
        history.shift();
    }

    log('INFO', `OpenRouter request: model=${modelId}, messages=${history.length}`);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/fredngg/tinyclaw',
            'X-Title': 'TinyClaw',
        },
        body: JSON.stringify({
            model: modelId,
            messages: history,
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenRouter API error (${response.status}): ${errorBody}`);
    }

    const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
    };

    if (data.error) {
        throw new Error(`OpenRouter error: ${data.error.message}`);
    }

    const assistantMessage = data.choices?.[0]?.message?.content || '';

    if (!assistantMessage) {
        throw new Error('OpenRouter returned empty response');
    }

    // Append assistant response to history for future continuity
    history.push({ role: 'assistant', content: assistantMessage });

    return assistantMessage;
}

/**
 * Invoke a single agent with a message. Contains all invocation logic.
 * Returns the raw response text.
 */
export async function invokeAgent(
    agent: AgentConfig,
    agentId: string,
    message: string,
    workspacePath: string,
    shouldReset: boolean,
    agents: Record<string, AgentConfig> = {},
    teams: Record<string, TeamConfig> = {}
): Promise<string> {
    // Ensure agent directory exists with config files
    const agentDir = path.join(workspacePath, agentId);
    const isNewAgent = !fs.existsSync(agentDir);
    ensureAgentDirectory(agentDir);
    if (isNewAgent) {
        log('INFO', `Initialized agent directory with config files: ${agentDir}`);
    }

    // Update AGENTS.md with current teammate info
    updateAgentTeammates(agentDir, agentId, agents, teams);

    // SECURITY: All providers route through OpenRouter HTTP API.
    // No local CLI execution. OpenRouter supports both Anthropic and OpenAI models.
    const provider = agent.provider || 'openrouter';

    if (provider === 'openai') {
        log('WARN', `Provider "openai" is deprecated. Routing through OpenRouter. ` +
            `Update settings to use provider: "openrouter" (agent: ${agentId})`);
    }

    log('INFO', `Using OpenRouter provider (agent: ${agentId})`);
    const modelId = resolveOpenRouterModel(agent.model);
    return await invokeOpenRouter(agentId, message, modelId, shouldReset);
}
