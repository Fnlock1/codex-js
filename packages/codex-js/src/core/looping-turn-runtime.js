/**
 * 中文模块说明：src/core/looping-turn-runtime.js
 *
 * 核心模型/工具循环 runtime，持续执行 tool call 并把结果回灌给模型。
 */
import { randomUUID } from "node:crypto";
import {
  ITEM_STATUSES,
  createAssistantMessageItem,
  createErrorEvent,
  createItemCompletedEvent,
  createItemStartedEvent,
  createItemUpdatedEvent,
  createResponseInputMessageItem,
  createReasoningItem,
  createResponseToolCallOutputItem,
  createThreadStartedEvent,
  createToolCallItem,
  createToolResultItem,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
  createUserMessageItem
} from "../protocol/index.js";
import {
  NoopToolCallRuntime,
  TOOL_CALL_RESULT_STATUSES,
  createToolCallRequest
} from "../tools/runtime.js";
import {
  MODEL_RESPONSE_ITEM_TYPES,
  MockModelClient,
  createModelPrompt,
  defaultMockResponse,
  isAssistantModelResponseItem,
  isReasoningModelResponseItem,
  isToolCallModelResponseItem
} from "./model-client.js";
import {
  appendReactAction,
  appendReactThought,
  completeReactAction,
  completeReactTrace,
  createReactTrace,
  reactTraceToJSON
} from "./react-trace.js";
import { TurnContext } from "./turn-context.js";
import { TurnRuntime } from "./turn-runtime.js";
import {
  completeConvergenceTrace,
  convergenceTraceToJSON,
  createConvergenceTrace,
  recordConvergenceBudgetWarning,
  recordConvergenceRepeatedToolWarning,
  recordConvergenceToolCall
} from "./convergence-trace.js";
import {
  createToolLoopDetector,
  formatRepeatedToolCallWarning
} from "./tool-loop-detector.js";
import {
  DEFAULT_MAX_TOOL_ITERATIONS,
  createToolIterationBudget,
  createToolIterationLimitError,
  formatToolIterationWarning,
  toolIterationState
} from "./tool-iteration-budget.js";

export { DEFAULT_MAX_TOOL_ITERATIONS };

/**
 * 支持工具循环的核心 turn runtime。
 *
 * 它会反复调用模型：模型返回 tool_call 时执行工具并把结果加入
 * responseInputItems；模型不再请求工具时，才完成 assistant 最终消息。
 */
export class LoopingTurnRuntime extends TurnRuntime {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.modelClient = options.modelClient ?? new MockModelClient({
      mockResponse: options.mockResponse
    });
    this.toolRuntime = options.toolRuntime ?? new NoopToolCallRuntime();
    this.toolIterationBudget = createToolIterationBudget({
      maxToolIterations: options.maxToolIterations,
      warningRemaining: options.toolIterationWarningRemaining
    });
    this.maxToolIterations = this.toolIterationBudget.maxIterations;
    this.toolLoopDetectorOptions = {
      threshold: options.repeatedToolCallThreshold
    };
  }

  /**
   * 执行一轮 agent turn 并按事件流产出进度。
   *
   * 这是异步生成器，会按需产出事件或结果。
   *
   * @param {unknown} context - context 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async *runTurn(context) {
    const turnContext = context instanceof TurnContext
      ? context
      : new TurnContext(context);
    const promptText = turnContext.inputText();
    const userItem = createUserMessageItem(promptText);
    const modelSession = this.modelClient.createSession();
    const assistantId = randomUUID();
    const assistantStarted = createAssistantMessageItem("", {
      id: assistantId,
      status: ITEM_STATUSES.IN_PROGRESS
    });
    const responseInputItems = [...turnContext.responseInputItems];
    const reactTrace = createReactTrace();
    const convergenceTrace = createConvergenceTrace({
      maxToolIterations: this.maxToolIterations,
      doneCriteria: turnContext.doneCriteria
    });

    yield createThreadStartedEvent(turnContext.threadId);
    yield createTurnStartedEvent();
    yield createItemCompletedEvent(userItem);
    yield createItemStartedEvent(assistantStarted);

    try {
      let responseText = "";
      let budgetWarningInjected = false;
      let repeatedToolWarningInjected = false;
      const toolLoopDetector = createToolLoopDetector(this.toolLoopDetectorOptions);

      for (let iteration = 0; iteration <= this.maxToolIterations; iteration += 1) {
        const iterationState = toolIterationState(iteration, this.toolIterationBudget);

        if (iterationState.isFinalIteration) {
          throw createToolIterationLimitError(iterationState);
        }

        if (iterationState.shouldWarn && !budgetWarningInjected) {
          budgetWarningInjected = true;
          recordConvergenceBudgetWarning(convergenceTrace);
          responseInputItems.push(createResponseInputMessageItem({
            role: "system",
            text: formatToolIterationWarning(iterationState)
          }));
        }

        const modelPrompt = createModelPrompt(turnContext);
        modelPrompt.responseInputItems = [...responseInputItems];
        const turnResponse = await collectModelResponse(modelSession, modelPrompt);
        let toolCallsThisIteration = 0;

        for (const responseItem of turnResponse) {
          if (isToolCallModelResponseItem(responseItem)) {
            toolCallsThisIteration += 1;
            const loopState = toolLoopDetector.record(responseItem);
            const reactStep = appendReactAction(reactTrace, {
              name: responseItem.name,
              arguments: responseItem.arguments
            });
            const toolResult = yield* this.runToolCall(responseItem, turnContext);
            completeReactAction(reactStep, toolResult.result.output, {
              failed: toolResult.result.status === TOOL_CALL_RESULT_STATUSES.FAILED,
              error: toolResult.result.error
            });
            recordConvergenceToolCall(convergenceTrace, {
              iteration,
              toolName: responseItem.name,
              failed: toolResult.result.status === TOOL_CALL_RESULT_STATUSES.FAILED,
              compressedOutput: Boolean(toolResult.result.raw?.outputSummary?.compressed)
            });
            responseInputItems.push(toolResult.responseInputItem);

            if (loopState.repeated && !repeatedToolWarningInjected) {
              repeatedToolWarningInjected = true;
              recordConvergenceRepeatedToolWarning(convergenceTrace, loopState);
              responseInputItems.push(createResponseInputMessageItem({
                role: "system",
                text: formatRepeatedToolCallWarning(loopState)
              }));
            }

            continue;
          }

          if (isReasoningModelResponseItem(responseItem)) {
            appendReactThought(reactTrace, responseItem.summary ?? responseItem.text ?? responseItem.content);
            yield createItemCompletedEvent(createReasoningItem({
              id: responseItem.id || undefined,
              summaryText: reasoningSummaryText(responseItem.summary),
              rawContent: reasoningRawContent(responseItem.content)
            }));
            continue;
          }

          if (isAssistantModelResponseItem(responseItem)) {
            responseText += responseItem.text;
            yield createItemUpdatedEvent(createAssistantMessageItem(responseText, {
              id: assistantId,
              status: ITEM_STATUSES.IN_PROGRESS
            }));
          }
        }

        if (toolCallsThisIteration === 0) {
          completeReactTrace(reactTrace);
          completeConvergenceTrace(convergenceTrace, {
            reason: "final_answer"
          });
          turnContext.metadata.react_trace = reactTraceToJSON(reactTrace);
          turnContext.metadata.convergence_trace = convergenceTraceToJSON(convergenceTrace);
          yield createItemCompletedEvent(createAssistantMessageItem(responseText, {
            id: assistantId,
            status: ITEM_STATUSES.COMPLETED
          }));
          yield createTurnCompletedEvent();
          return;
        }
      }

      throw createToolIterationLimitError(toolIterationState(this.maxToolIterations, this.toolIterationBudget));
    } catch (error) {
      completeReactTrace(reactTrace, {
        failed: true
      });
      completeConvergenceTrace(convergenceTrace, {
        failed: true,
        reason: error.code === "tool_iteration_limit" ? "tool_iteration_limit" : "error",
        errorCode: error.code ?? null
      });
      turnContext.metadata.react_trace = reactTraceToJSON(reactTrace);
      turnContext.metadata.convergence_trace = convergenceTraceToJSON(convergenceTrace);
      yield createItemCompletedEvent(createAssistantMessageItem("", {
        id: assistantId,
        status: ITEM_STATUSES.FAILED
      }));
      yield createTurnFailedEvent(error);
      yield createErrorEvent(error);
    }
  }

  /**
   * 执行模型请求的工具调用并产出工具事件。
   *
   * 这是异步生成器，会按需产出事件或结果。
   *
   * @param {unknown} responseItem - responseItem 参数。
   * @param {unknown} turnContext - turnContext 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async *runToolCall(responseItem, turnContext) {
    const request = createToolCallRequest({
      callId: responseItem.call_id ?? responseItem.callId ?? responseItem.id ?? randomUUID(),
      name: responseItem.name,
      arguments: responseItem.arguments,
      raw: responseItem.raw
    });
    const startedItem = createToolCallItem({
      callId: request.call_id,
      name: request.name,
      arguments: request.arguments,
      status: ITEM_STATUSES.IN_PROGRESS
    });

    yield createItemStartedEvent(startedItem);

    const result = await this.toolRuntime.run(request, {
      turnContext
    });
    const status = result.status === TOOL_CALL_RESULT_STATUSES.FAILED
      ? ITEM_STATUSES.FAILED
      : ITEM_STATUSES.COMPLETED;
    const responseInputItem = createResponseToolCallOutputItem(responseItem, result);

    yield createItemCompletedEvent(createToolCallItem({
      id: startedItem.id,
      callId: request.call_id,
      name: request.name,
      arguments: request.arguments,
      output: result.output,
      error: result.error,
      status
    }));
    yield createItemCompletedEvent(createToolResultItem({
      callId: request.call_id,
      name: request.name,
      output: result.output,
      error: result.error,
      status,
      responseInputItem
    }));

    return {
      result,
      responseInputItem
    };
  }
}

export { defaultMockResponse };

/**
 * 处理 collect model response 相关逻辑。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} modelSession - modelSession 参数。
 * @param {unknown} modelPrompt - modelPrompt 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function collectModelResponse(modelSession, modelPrompt) {
  const response = [];

  for await (const item of modelSession.streamResponse(modelPrompt)) {
    response.push(item);
  }

  return response;
}

/**
 * 处理 reasoning summary text 相关逻辑。
 *
 * @param {unknown} summary - summary 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function reasoningSummaryText(summary) {
  return (Array.isArray(summary) ? summary : [])
    .map((entry) => entry?.text ?? "")
    .filter(Boolean);
}

/**
 * 处理 reasoning raw content 相关逻辑。
 *
 * @param {unknown} content - content 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function reasoningRawContent(content) {
  return (Array.isArray(content) ? content : [])
    .map((entry) => entry?.text ?? "")
    .filter(Boolean);
}
