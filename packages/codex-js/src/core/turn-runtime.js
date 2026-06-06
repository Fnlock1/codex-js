import { randomUUID } from "node:crypto";
import {
  createAssistantMessageItem,
  createErrorEvent,
  createItemCompletedEvent,
  createItemStartedEvent,
  createItemUpdatedEvent,
  createReasoningItem,
  createResponseToolCallOutputItem,
  createToolCallItem,
  createToolResultItem,
  createThreadStartedEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
  createUserMessageItem,
  ITEM_STATUSES
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
  defaultMockResponse
} from "./model-client.js";
import { TurnContext } from "./turn-context.js";

export class TurnRuntime {
  async *runTurn(_context) {
    throw new Error("TurnRuntime.runTurn() must be implemented by a subclass.");
  }
}

export class MockTurnRuntime extends TurnRuntime {
  constructor(options = {}) {
    super();
    this.modelClient = options.modelClient ?? new MockModelClient({
      mockResponse: options.mockResponse
    });
    this.toolRuntime = options.toolRuntime ?? new NoopToolCallRuntime();
  }

  async *runTurn(context) {
    const turnContext = context instanceof TurnContext
      ? context
      : new TurnContext(context);
    const prompt = turnContext.inputText();
    const userItem = createUserMessageItem(prompt);
    const modelSession = this.modelClient.createSession();
    const modelPrompt = createModelPrompt(turnContext);
    const assistantId = randomUUID();
    const assistantStarted = createAssistantMessageItem("", {
      id: assistantId,
      status: ITEM_STATUSES.IN_PROGRESS
    });

    yield createThreadStartedEvent(turnContext.threadId);
    yield createTurnStartedEvent();
    yield createItemCompletedEvent(userItem);
    yield createItemStartedEvent(assistantStarted);

    try {
      let responseText = "";
      for await (const responseItem of modelSession.streamResponse(modelPrompt)) {
        if (responseItem.type === MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL) {
          yield* this.runToolCall(responseItem, turnContext);
          continue;
        }

        if (responseItem.type === MODEL_RESPONSE_ITEM_TYPES.REASONING) {
          yield createItemCompletedEvent(createReasoningItem({
            id: responseItem.id || undefined,
            summaryText: reasoningSummaryText(responseItem.summary),
            rawContent: reasoningRawContent(responseItem.content)
          }));
          continue;
        }

        if (responseItem.type !== MODEL_RESPONSE_ITEM_TYPES.ASSISTANT_MESSAGE) {
          continue;
        }

        responseText += responseItem.text;
        yield createItemUpdatedEvent(createAssistantMessageItem(responseText, {
          id: assistantId,
          status: ITEM_STATUSES.IN_PROGRESS
        }));
      }

      yield createItemCompletedEvent(createAssistantMessageItem(responseText, {
        id: assistantId,
        status: ITEM_STATUSES.COMPLETED
      }));
      yield createTurnCompletedEvent();
    } catch (error) {
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
    const responseInputItem = createResponseToolCallOutputItem(responseItem, result);
    const completedItem = createToolCallItem({
      id: startedItem.id,
      callId: request.call_id,
      name: request.name,
      arguments: request.arguments,
      output: result.output,
      error: result.error,
      status: result.status === TOOL_CALL_RESULT_STATUSES.FAILED
        ? ITEM_STATUSES.FAILED
        : ITEM_STATUSES.COMPLETED
    });

    yield createItemCompletedEvent(completedItem);
    yield createItemCompletedEvent(createToolResultItem({
      callId: request.call_id,
      name: request.name,
      output: result.output,
      error: result.error,
      status: result.status === TOOL_CALL_RESULT_STATUSES.FAILED
        ? ITEM_STATUSES.FAILED
        : ITEM_STATUSES.COMPLETED,
      responseInputItem
    }));
  }
}

export { defaultMockResponse };

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
