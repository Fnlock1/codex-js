import { randomUUID } from "node:crypto";
import {
  ITEM_STATUSES,
  createAssistantMessageItem,
  createErrorEvent,
  createItemCompletedEvent,
  createItemStartedEvent,
  createItemUpdatedEvent,
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

export const DEFAULT_MAX_TOOL_ITERATIONS = 12;

export class LoopingTurnRuntime extends TurnRuntime {
  constructor(options = {}) {
    super();
    this.modelClient = options.modelClient ?? new MockModelClient({
      mockResponse: options.mockResponse
    });
    this.toolRuntime = options.toolRuntime ?? new NoopToolCallRuntime();
    this.maxToolIterations = options.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  }

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
    const responseInputItems = [];
    const reactTrace = createReactTrace();

    yield createThreadStartedEvent(turnContext.threadId);
    yield createTurnStartedEvent();
    yield createItemCompletedEvent(userItem);
    yield createItemStartedEvent(assistantStarted);

    try {
      let responseText = "";

      for (let iteration = 0; iteration <= this.maxToolIterations; iteration += 1) {
        const modelPrompt = createModelPrompt(turnContext);
        modelPrompt.responseInputItems = [...responseInputItems];
        const turnResponse = await collectModelResponse(modelSession, modelPrompt);
        let toolCallsThisIteration = 0;

        for (const responseItem of turnResponse) {
          if (isToolCallModelResponseItem(responseItem)) {
            toolCallsThisIteration += 1;
            const reactStep = appendReactAction(reactTrace, {
              name: responseItem.name,
              arguments: responseItem.arguments
            });
            const toolResult = yield* this.runToolCall(responseItem, turnContext);
            completeReactAction(reactStep, toolResult.result.output, {
              failed: toolResult.result.status === TOOL_CALL_RESULT_STATUSES.FAILED,
              error: toolResult.result.error
            });
            responseInputItems.push(toolResult.responseInputItem);
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
          turnContext.metadata.react_trace = reactTraceToJSON(reactTrace);
          yield createItemCompletedEvent(createAssistantMessageItem(responseText, {
            id: assistantId,
            status: ITEM_STATUSES.COMPLETED
          }));
          yield createTurnCompletedEvent();
          return;
        }
      }

      throw new Error(`max tool iterations exceeded: ${this.maxToolIterations}`);
    } catch (error) {
      completeReactTrace(reactTrace, {
        failed: true
      });
      turnContext.metadata.react_trace = reactTraceToJSON(reactTrace);
      yield createItemCompletedEvent(createAssistantMessageItem("", {
        id: assistantId,
        status: ITEM_STATUSES.FAILED
      }));
      yield createTurnFailedEvent(error);
      yield createErrorEvent(error);
    }
  }

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

async function collectModelResponse(modelSession, modelPrompt) {
  const response = [];

  for await (const item of modelSession.streamResponse(modelPrompt)) {
    response.push(item);
  }

  return response;
}

function reasoningSummaryText(summary) {
  return (Array.isArray(summary) ? summary : [])
    .map((entry) => entry?.text ?? "")
    .filter(Boolean);
}

function reasoningRawContent(content) {
  return (Array.isArray(content) ? content : [])
    .map((entry) => entry?.text ?? "")
    .filter(Boolean);
}
