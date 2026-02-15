import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { AgentConfig, TeamConfig, ConversationMessage } from './types';
import { SCRIPT_DIR, resolveOpenRouterModel, resolveCodexModel } from './config';
import { log } from './logging';
import { ensureAgentDirectory, updateAgentTeammates } from './agent-setup';

// In-memory conversation history per agent (for multi-turn continuity)
const agentConversations = new Map<string, ConversationMessage[]>();

const MAX_HISTORY_MESSAGES = 40; // keep last N messages to avoid unbounded growth

export async function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: cwd || SCRIPT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });

        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        child.on('error', (error) => {
            reject(error);
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }

            const errorMessage = stderr.trim() || `Command exited with code ${code}`;
            reject(new Error(errorMessage));
        });
    });
}

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

    const provider = agent.provider || 'openrouter';

    if (provider === 'openai') {
        log('INFO', `Using Codex CLI (agent: ${agentId})`);

        const shouldResume = !shouldReset;

        if (shouldReset) {
            log('INFO', `🔄 Resetting Codex conversation for agent: ${agentId}`);
        }

        const modelId = resolveCodexModel(agent.model);
        const codexArgs = ['exec'];
        if (shouldResume) {
            codexArgs.push('resume', '--last');
        }
        if (modelId) {
            codexArgs.push('--model', modelId);
        }

        // Resolve working directory
        const workingDir = agent.working_directory
            ? (path.isAbsolute(agent.working_directory)
                ? agent.working_directory
                : path.join(workspacePath, agent.working_directory))
            : agentDir;

        codexArgs.push('--json', message);

        const codexOutput = await runCommand('codex', codexArgs, workingDir);

        // Parse JSONL output and extract final agent_message
        let response = '';
        const lines = codexOutput.trim().split('\n');
        for (const line of lines) {
            try {
                const json = JSON.parse(line);
                if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
                    response = json.item.text;
                }
            } catch (e) {
                // Ignore lines that aren't valid JSON
            }
        }

        return response || 'Sorry, I could not generate a response from Codex.';
    } else {
        // Default to OpenRouter (replaces Claude CLI)
        log('INFO', `Using OpenRouter provider (agent: ${agentId})`);

        const modelId = resolveOpenRouterModel(agent.model);

        return await invokeOpenRouter(agentId, message, modelId, shouldReset);
    }
}
