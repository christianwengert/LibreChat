/* eslint-disable prettier/prettier */
'use strict';

var nanoid = require('nanoid');
var stream = require('@langchain/core/utils/stream');
var googleVertexai = require('@langchain/google-vertexai');
var langgraph = require('@langchain/langgraph');
var dispatch = require('@langchain/core/callbacks/dispatch');
var messages = require('@langchain/core/messages');
var _enum = require('../common/enum.cjs');
var providers = require('../llm/providers.cjs');
var ToolNode = require('../tools/ToolNode.cjs');
var core = require('../messages/core.cjs');
var prune = require('../messages/prune.cjs');
var graph = require('../utils/graph.cjs');
var llm = require('../utils/llm.cjs');
var run = require('../utils/run.cjs');
require('js-tiktoken/lite');
var index = require('../llm/openai/index.cjs');
var fake = require('../llm/fake.cjs');

/* eslint-disable no-console */
// src/graphs/Graph.ts
const { AGENT, TOOLS } = _enum.GraphNodeKeys;
console.log("RAGGGA")
class Graph {
    lastToken;
    tokenTypeSwitch;
    reasoningKey = 'reasoning_content';
    currentTokenType = _enum.ContentTypes.TEXT;
    messageStepHasToolCalls = new Map();
    messageIdsByStepKey = new Map();
    prelimMessageIdsByStepKey = new Map();
    config;
    contentData = [];
    stepKeyIds = new Map();
    contentIndexMap = new Map();
    toolCallStepIds = new Map();
    currentUsage;
    indexTokenCountMap = {};
    maxContextTokens;
    pruneMessages;
    /** The amount of time that should pass before another consecutive API call */
    streamBuffer;
    tokenCounter;
    signal;
    /** Set of invoked tool call IDs from non-message run steps completed mid-run, if any */
    invokedToolIds;
    handlerRegistry;
}
class StandardGraph extends Graph {
    graphState;
    clientOptions;
    boundModel;
    /** The last recorded timestamp that a stream API call was invoked */
    lastStreamCall;
    systemMessage;
    messages = [];
    runId;
    tools;
    toolMap;
    startIndex = 0;
    provider;
    toolEnd;
    signal;
    constructor({ runId, tools, signal, toolMap, provider, streamBuffer, instructions, reasoningKey, clientOptions, toolEnd = false, additional_instructions = '', }) {
        super();
        this.runId = runId;
        this.tools = tools;
        this.signal = signal;
        this.toolEnd = toolEnd;
        this.toolMap = toolMap;
        this.provider = provider;
        this.streamBuffer = streamBuffer;
        this.clientOptions = clientOptions;
        this.graphState = this.createGraphState();
        this.boundModel = this.initializeModel();
        if (reasoningKey) {
            this.reasoningKey = reasoningKey;
        }
        let finalInstructions = instructions;
        if (additional_instructions) {
            finalInstructions =
                finalInstructions != null && finalInstructions
                    ? `${finalInstructions}\n\n${additional_instructions}`
                    : additional_instructions;
        }
        if (finalInstructions != null &&
            finalInstructions &&
            provider === _enum.Providers.ANTHROPIC &&
            (clientOptions.clientOptions
                ?.defaultHeaders?.['anthropic-beta']?.includes('prompt-caching') ??
                false)) {
            finalInstructions = {
                content: [
                    {
                        type: 'text',
                        text: instructions,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
            };
        }
        if (finalInstructions != null && finalInstructions !== '') {
            this.systemMessage = new messages.SystemMessage(finalInstructions);
        }
    }
    /* Init */
    resetValues(keepContent) {
        this.messages = [];
        this.config = graph.resetIfNotEmpty(this.config, undefined);
        if (keepContent !== true) {
            this.contentData = graph.resetIfNotEmpty(this.contentData, []);
            this.contentIndexMap = graph.resetIfNotEmpty(this.contentIndexMap, new Map());
        }
        this.stepKeyIds = graph.resetIfNotEmpty(this.stepKeyIds, new Map());
        this.toolCallStepIds = graph.resetIfNotEmpty(this.toolCallStepIds, new Map());
        this.messageIdsByStepKey = graph.resetIfNotEmpty(this.messageIdsByStepKey, new Map());
        this.messageStepHasToolCalls = graph.resetIfNotEmpty(this.prelimMessageIdsByStepKey, new Map());
        this.prelimMessageIdsByStepKey = graph.resetIfNotEmpty(this.prelimMessageIdsByStepKey, new Map());
        this.currentTokenType = graph.resetIfNotEmpty(this.currentTokenType, _enum.ContentTypes.TEXT);
        this.lastToken = graph.resetIfNotEmpty(this.lastToken, undefined);
        this.tokenTypeSwitch = graph.resetIfNotEmpty(this.tokenTypeSwitch, undefined);
        this.indexTokenCountMap = graph.resetIfNotEmpty(this.indexTokenCountMap, {});
        this.currentUsage = graph.resetIfNotEmpty(this.currentUsage, undefined);
        this.tokenCounter = graph.resetIfNotEmpty(this.tokenCounter, undefined);
        this.maxContextTokens = graph.resetIfNotEmpty(this.maxContextTokens, undefined);
        this.invokedToolIds = graph.resetIfNotEmpty(this.invokedToolIds, undefined);
    }
    /* Run Step Processing */
    getRunStep(stepId) {
        const index = this.contentIndexMap.get(stepId);
        if (index !== undefined) {
            return this.contentData[index];
        }
        return undefined;
    }
    getStepKey(metadata) {
        if (!metadata)
            return '';
        const keyList = this.getKeyList(metadata);
        if (this.checkKeyList(keyList)) {
            throw new Error('Missing metadata');
        }
        return graph.joinKeys(keyList);
    }
    getStepIdByKey(stepKey, index) {
        const stepIds = this.stepKeyIds.get(stepKey);
        if (!stepIds) {
            throw new Error(`No step IDs found for stepKey ${stepKey}`);
        }
        if (index === undefined) {
            return stepIds[stepIds.length - 1];
        }
        return stepIds[index];
    }
    generateStepId(stepKey) {
        const stepIds = this.stepKeyIds.get(stepKey);
        let newStepId;
        let stepIndex = 0;
        if (stepIds) {
            stepIndex = stepIds.length;
            newStepId = `step_${nanoid.nanoid()}`;
            stepIds.push(newStepId);
            this.stepKeyIds.set(stepKey, stepIds);
        }
        else {
            newStepId = `step_${nanoid.nanoid()}`;
            this.stepKeyIds.set(stepKey, [newStepId]);
        }
        return [newStepId, stepIndex];
    }
    getKeyList(metadata) {
        if (!metadata)
            return [];
        const keyList = [
            metadata.run_id,
            metadata.thread_id,
            metadata.langgraph_node,
            metadata.langgraph_step,
            metadata.checkpoint_ns,
        ];
        if (this.currentTokenType === _enum.ContentTypes.THINK ||
            this.currentTokenType === 'think_and_text') {
            keyList.push('reasoning');
        }
        if (this.invokedToolIds != null && this.invokedToolIds.size > 0) {
            keyList.push(this.invokedToolIds.size + '');
        }
        return keyList;
    }
    checkKeyList(keyList) {
        return keyList.some((key) => key === undefined);
    }
    /* Misc.*/
    getRunMessages() {
        return this.messages.slice(this.startIndex);
    }
    getContentParts() {
        return core.convertMessagesToContent(this.messages.slice(this.startIndex));
    }
    /* Graph */
    createGraphState() {
        return {
            messages: {
                value: (x, y) => {
                    if (!x.length) {
                        if (this.systemMessage) {
                            x.push(this.systemMessage);
                        }
                        this.startIndex = x.length + y.length;
                    }
                    const current = x.concat(y);
                    this.messages = current;
                    return current;
                },
                default: () => [],
            },
        };
    }
    initializeTools() {
        // return new ToolNode<t.BaseGraphState>(this.tools);
        return new ToolNode.ToolNode({
            tools: this.tools || [],
            toolMap: this.toolMap,
            toolCallStepIds: this.toolCallStepIds,
            errorHandler: (data, metadata) => StandardGraph.handleToolCallErrorStatic(this, data, metadata),
        });
    }
    initializeModel() {
        const ChatModelClass = providers.getChatModelClass(this.provider);
        const model = new ChatModelClass(this.clientOptions);
        if (llm.isOpenAILike(this.provider) &&
            (model instanceof index.ChatOpenAI || model instanceof index.AzureChatOpenAI)) {
            model.temperature = this.clientOptions
                .temperature;
            model.topP = this.clientOptions.topP;
            model.frequencyPenalty = this.clientOptions
                .frequencyPenalty;
            model.presencePenalty = this.clientOptions
                .presencePenalty;
            model.n = this.clientOptions.n;
        }
        else if (this.provider === _enum.Providers.VERTEXAI &&
            model instanceof googleVertexai.ChatVertexAI) {
            model.temperature = this.clientOptions
                .temperature;
            model.topP = this.clientOptions
                .topP;
            model.topK = this.clientOptions
                .topK;
            model.topLogprobs = this.clientOptions
                .topLogprobs;
            model.frequencyPenalty = this.clientOptions
                .frequencyPenalty;
            model.presencePenalty = this.clientOptions
                .presencePenalty;
            model.maxOutputTokens = this.clientOptions
                .maxOutputTokens;
        }
        if (!this.tools || this.tools.length === 0) {
            return model;
        }
        return model.bindTools(this.tools);
    }
    overrideTestModel(responses, sleep, toolCalls) {
        this.boundModel = fake.createFakeStreamingLLM({
            responses,
            sleep,
            toolCalls,
        });
    }
    getNewModel({ provider, clientOptions, omitOptions, }) {
        const ChatModelClass = providers.getChatModelClass(provider);
        const options = omitOptions && clientOptions == null
            ? Object.assign(Object.fromEntries(Object.entries(this.clientOptions).filter(([key]) => !omitOptions.has(key))), clientOptions)
            : (clientOptions ?? this.clientOptions);
        return new ChatModelClass(options);
    }
    storeUsageMetadata(finalMessage) {
        if (finalMessage &&
            'usage_metadata' in finalMessage &&
            finalMessage.usage_metadata != null) {
            this.currentUsage = finalMessage.usage_metadata;
        }
    }
    cleanupSignalListener() {
        if (!this.signal) {
            return;
        }
        if (!this.boundModel) {
            return;
        }
        const client = this.boundModel?.exposedClient;
        if (!client?.abortHandler) {
            return;
        }
        this.signal.removeEventListener('abort', client.abortHandler);
        client.abortHandler = undefined;
    }
    createCallModel() {
        return async (state, config) => {
            const { provider = '' } = config?.configurable ?? {};
            if (this.boundModel == null) {
                throw new Error('No Graph model found');
            }
            if (!config || !provider) {
                throw new Error(`No ${config ? 'provider' : 'config'} provided`);
            }
            if (!config.signal) {
                config.signal = this.signal;
            }
            this.config = config;
            const { messages: messages$1 } = state;
            let messagesToUse = messages$1;
            if (!this.pruneMessages &&
                this.tokenCounter &&
                this.maxContextTokens != null &&
                this.indexTokenCountMap[0] != null) {
                const isAnthropicWithThinking = (this.provider === _enum.Providers.ANTHROPIC &&
                    this.clientOptions.thinking !=
                        null) ||
                    (this.provider === _enum.Providers.BEDROCK &&
                        this.clientOptions
                            .additionalModelRequestFields?.['thinking'] != null);
                this.pruneMessages = prune.createPruneMessages({
                    provider: this.provider,
                    indexTokenCountMap: this.indexTokenCountMap,
                    maxTokens: this.maxContextTokens,
                    tokenCounter: this.tokenCounter,
                    startIndex: this.startIndex,
                    thinkingEnabled: isAnthropicWithThinking,
                });
            }
            if (this.pruneMessages) {
                const { context, indexTokenCountMap } = this.pruneMessages({
                    messages: messages$1,
                    usageMetadata: this.currentUsage,
                    // startOnMessageType: 'human',
                });
                this.indexTokenCountMap = indexTokenCountMap;
                messagesToUse = context;
            }
            const finalMessages = messagesToUse;
            const lastMessageX = finalMessages.length >= 2
                ? finalMessages[finalMessages.length - 2]
                : null;
            const lastMessageY = finalMessages.length >= 1
                ? finalMessages[finalMessages.length - 1]
                : null;
            if (provider === _enum.Providers.BEDROCK &&
                lastMessageX instanceof messages.AIMessageChunk &&
                lastMessageY instanceof messages.ToolMessage &&
                typeof lastMessageX.content === 'string') {
                finalMessages[finalMessages.length - 2].content = '';
            }
            const isLatestToolMessage = lastMessageY instanceof messages.ToolMessage;
            if (isLatestToolMessage && provider === _enum.Providers.ANTHROPIC) {
                core.formatAnthropicArtifactContent(finalMessages);
            }
            else if (isLatestToolMessage &&
                (llm.isOpenAILike(provider) || llm.isGoogleLike(provider))) {
                core.formatArtifactPayload(finalMessages);
            }
            if (this.lastStreamCall != null && this.streamBuffer != null) {
                const timeSinceLastCall = Date.now() - this.lastStreamCall;
                if (timeSinceLastCall < this.streamBuffer) {
                    const timeToWait = Math.ceil((this.streamBuffer - timeSinceLastCall) / 1000) * 1000;
                    await run.sleep(timeToWait);
                }
            }
            this.lastStreamCall = Date.now();
            let result;
            if ((this.tools?.length ?? 0) > 0 &&
                providers.manualToolStreamProviders.has(provider)) {
                const stream$1 = await this.boundModel.stream(finalMessages, config);
                let finalChunk;
                for await (const chunk of stream$1) {
                    dispatch.dispatchCustomEvent(_enum.GraphEvents.CHAT_MODEL_STREAM, { chunk }, config);
                    if (!finalChunk) {
                        finalChunk = chunk;
                    }
                    else {
                        finalChunk = stream.concat(finalChunk, chunk);
                    }
                }
                finalChunk = core.modifyDeltaProperties(this.provider, finalChunk);
                result = { messages: [finalChunk] };
            }
            else {
                const finalMessage = (await this.boundModel.invoke(finalMessages, config));
                if ((finalMessage.tool_calls?.length ?? 0) > 0) {
                    finalMessage.tool_calls = finalMessage.tool_calls?.filter((tool_call) => {
                        if (!tool_call.name) {
                            return false;
                        }
                        return true;
                    });
                }
                result = { messages: [finalMessage] };
            }
            this.storeUsageMetadata(result.messages?.[0]);
            this.cleanupSignalListener();
            return result;
        };
    }
    createWorkflow() {
        const routeMessage = (state, config) => {
            this.config = config;
            return ToolNode.toolsCondition(state, this.invokedToolIds);
        };
        const workflow = new langgraph.StateGraph({
            channels: this.graphState,
        })
            .addNode(AGENT, this.createCallModel())
            .addNode(TOOLS, this.initializeTools())
            .addEdge(langgraph.START, AGENT)
            .addConditionalEdges(AGENT, routeMessage)
            .addEdge(TOOLS, this.toolEnd ? langgraph.END : AGENT);
        return workflow.compile();
    }
    /* Dispatchers */
    /**
     * Dispatches a run step to the client, returns the step ID
     */
    dispatchRunStep(stepKey, stepDetails) {
        if (!this.config) {
            throw new Error('No config provided');
        }
        const [stepId, stepIndex] = this.generateStepId(stepKey);
        if (stepDetails.type === _enum.StepTypes.TOOL_CALLS && stepDetails.tool_calls) {
            for (const tool_call of stepDetails.tool_calls) {
                const toolCallId = tool_call.id ?? '';
                if (!toolCallId || this.toolCallStepIds.has(toolCallId)) {
                    continue;
                }
                this.toolCallStepIds.set(toolCallId, stepId);
            }
        }
        const runStep = {
            stepIndex,
            id: stepId,
            type: stepDetails.type,
            index: this.contentData.length,
            stepDetails,
            usage: null,
        };
        const runId = this.runId ?? '';
        if (runId) {
            runStep.runId = runId;
        }
        this.contentData.push(runStep);
        this.contentIndexMap.set(stepId, runStep.index);
        dispatch.dispatchCustomEvent(_enum.GraphEvents.ON_RUN_STEP, runStep, this.config);
        return stepId;
    }
    handleToolCallCompleted(data, metadata, omitOutput) {
        if (!this.config) {
            throw new Error('No config provided');
        }
        if (!data.output) {
            return;
        }
        const { input, output } = data;
        const { tool_call_id } = output;

        // console.error(
        //   "[Graph] ToolCallCompleted with no step found",
        //   "tool_call_id:", tool_call_id,
        //   "current stepIds:", Object.keys(this.stepsByToolCallId || {})
        // );
        //

        // const stepId = this.toolCallStepIds.get(tool_call_id) ?? '';
        // if (!stepId) {
        //     throw new Error(`No stepId found for tool_call_id ${tool_call_id}`);
        // }


        let stepId = this.toolCallStepIds?.get(tool_call_id) ?? '';
        let runStep = null;
        if (!stepId) {
          // Late registration hot-fix: create a step if we never saw the start.
          try {
            const dispatchedArgs = typeof input === 'string' ? input : input?.input;
            const argsStr = typeof dispatchedArgs === 'string' ? dispatchedArgs : JSON.stringify(dispatchedArgs ?? '');
            const toolName = output.name ?? '';

            // Ensure containers exist
            this.runSteps = this.runSteps || [];
            this.toolCallStepIds = this.toolCallStepIds || new Map();
            // Some builds keep a fast lookup; if not present, create one
            this.runStepsById = this.runStepsById || new Map();

            stepId = `${Date.now()}-${tool_call_id}`;
            runStep = {
              id: stepId,
              index: this.runSteps.length,
              type: 'tool_call',
              tool_call: { id: tool_call_id, name: toolName, args: argsStr, output: '', progress: 0 },
            };

            // Register in all known places
            this.runSteps.push(runStep);
            this.runStepsById.set(stepId, runStep);
            this.toolCallStepIds.set(tool_call_id, stepId);

            // If your runtime expects a CREATED event before COMPLETED, emit it
            try {
              this.handlerRegistry?.getHandler(_enum.GraphEvents.ON_RUN_STEP_CREATED)
                ?.handle(
                  _enum.GraphEvents.ON_RUN_STEP_CREATED,
                  { result: { id: stepId, index: runStep.index, type: 'tool_call', tool_call: runStep.tool_call } },
                  metadata,
                  this
                );
            } catch (e) {
              // non-fatal: continue to completion
            }
            console.warn('[Graph] Late-registered tool_call_id', tool_call_id, 'as stepId', stepId);
          } catch (e) {
            console.error('[Graph] Failed to late-register tool_call_id', tool_call_id, e);
            throw new Error(`No stepId found for tool_call_id ${tool_call_id}`);
          }
        }

        // const runStep = this.getRunStep(stepId);
        // if (!runStep) {
        //     throw new Error(`No run step found for stepId ${stepId}`);
        // }
      if (!runStep) {
        runStep = this.getRunStep?.(stepId) || this.runStepsById?.get?.(stepId) || null;
        if (!runStep) {
          // Last-resort reconstruction (should rarely happen)
          const dispatchedArgs = typeof input === 'string' ? input : input?.input;
          const argsStr = typeof dispatchedArgs === 'string' ? dispatchedArgs : JSON.stringify(dispatchedArgs ?? '');
          runStep = {
            id: stepId,
            index: this.runSteps?.length ?? 0,
            type: 'tool_call',
            tool_call: { id: tool_call_id, name: output.name ?? '', args: argsStr, output: '', progress: 0 },
          };
          this.runSteps = this.runSteps || [];
          this.runSteps.push(runStep);
          this.runStepsById = this.runStepsById || new Map();
          this.runStepsById.set(stepId, runStep);
        }
      }
        const dispatchedOutput = typeof output.content === 'string'
            ? output.content
            : JSON.stringify(output.content);
        const args = typeof input === 'string' ? input : input.input;
        const tool_call = {
            args: typeof args === 'string' ? args : JSON.stringify(args),
            name: output.name ?? '',
            id: output.tool_call_id,
            output: omitOutput === true ? '' : dispatchedOutput,
            progress: 1,
        };
        this.handlerRegistry?.getHandler(_enum.GraphEvents.ON_RUN_STEP_COMPLETED)?.handle(_enum.GraphEvents.ON_RUN_STEP_COMPLETED, {
            result: {
                id: stepId,
                index: runStep.index,
                type: 'tool_call',
                tool_call,
            },
        }, metadata, this);
    }
    /**
     * Static version of handleToolCallError to avoid creating strong references
     * that prevent garbage collection
     */
    static handleToolCallErrorStatic(graph, data, metadata) {
        if (!graph.config) {
            throw new Error('No config provided');
        }
        if (!data.id) {
            console.warn('No Tool ID provided for Tool Error');
            return;
        }
        const stepId = graph.toolCallStepIds.get(data.id) ?? '';
        if (!stepId) {
            throw new Error(`No stepId found for tool_call_id ${data.id}`);
        }
        const { name, input: args, error } = data;
        const runStep = graph.getRunStep(stepId);
        if (!runStep) {
            throw new Error(`No run step found for stepId ${stepId}`);
        }
        const tool_call = {
            id: data.id,
            name: name || '',
            args: typeof args === 'string' ? args : JSON.stringify(args),
            output: `Error processing tool${error?.message != null ? `: ${error.message}` : ''}`,
            progress: 1,
        };
        graph.handlerRegistry
            ?.getHandler(_enum.GraphEvents.ON_RUN_STEP_COMPLETED)
            ?.handle(_enum.GraphEvents.ON_RUN_STEP_COMPLETED, {
            result: {
                id: stepId,
                index: runStep.index,
                type: 'tool_call',
                tool_call,
            },
        }, metadata, graph);
    }
    /**
     * Instance method that delegates to the static method
     * Kept for backward compatibility
     */
    handleToolCallError(data, metadata) {
        StandardGraph.handleToolCallErrorStatic(this, data, metadata);
    }
    dispatchRunStepDelta(id, delta) {
        if (!this.config) {
            throw new Error('No config provided');
        }
        else if (!id) {
            throw new Error('No step ID found');
        }
        const runStepDelta = {
            id,
            delta,
        };
        dispatch.dispatchCustomEvent(_enum.GraphEvents.ON_RUN_STEP_DELTA, runStepDelta, this.config);
    }
    dispatchMessageDelta(id, delta) {
        if (!this.config) {
            throw new Error('No config provided');
        }
        const messageDelta = {
            id,
            delta,
        };
        dispatch.dispatchCustomEvent(_enum.GraphEvents.ON_MESSAGE_DELTA, messageDelta, this.config);
    }
    dispatchReasoningDelta = (stepId, delta) => {
        if (!this.config) {
            throw new Error('No config provided');
        }
        const reasoningDelta = {
            id: stepId,
            delta,
        };
        dispatch.dispatchCustomEvent(_enum.GraphEvents.ON_REASONING_DELTA, reasoningDelta, this.config);
    };
}

exports.Graph = Graph;
exports.StandardGraph = StandardGraph;
//# sourceMappingURL=Graph.cjs.map