import {
  EVENT_TYPES,
  ITEM_TYPES,
  MESSAGE_ROLES,
  RESPONSE_INPUT_ITEM_TYPES,
  createResponseInputMessageItem,
  getItemText,
  normalizeResponseItems,
  responseItemToText,
  normalizeUserInput,
  userInputToText
} from "../protocol/index.js";

export const SESSION_SCHEMA_VERSION = 2;

export const HISTORY_ENTRY_TYPES = Object.freeze({
  USER_INPUT: "user_input",
  ASSISTANT_MESSAGE: "assistant_message",
  REASONING: "reasoning",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result",
  COMMAND_EXECUTION: "command_execution",
  ERROR: "error",
  INJECTED_RESPONSE_ITEM: "injected_response_item",
  COMPACT_SUMMARY: "compact_summary"
});

export function createSessionRecord(options = {}) {
  const now = new Date().toISOString();

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    threadId: String(options.threadId ?? ""),
    workingDirectory: options.workingDirectory ?? null,
    createdAt: options.createdAt ?? now,
    updatedAt: options.updatedAt ?? now,
    turns: Array.isArray(options.turns) ? options.turns : [],
    history: Array.isArray(options.history) ? options.history : [],
    responseInputItems: Array.isArray(options.responseInputItems) ? options.responseInputItems : [],
    rollout: Array.isArray(options.rollout) ? options.rollout : [],
    compact: options.compact ?? null,
    metadata: options.metadata ?? {}
  };
}

export function normalizeSessionRecord(session = {}, options = {}) {
  const base = createSessionRecord({
    ...session,
    threadId: session.threadId ?? session.thread_id ?? options.threadId,
    workingDirectory: session.workingDirectory ?? session.working_directory ?? options.workingDirectory
  });

  if (base.history.length === 0 && Array.isArray(session.turns)) {
    base.history = session.turns.flatMap((turn, index) => historyEntriesFromTurn({
      input: turn.input,
      events: turn.events ?? [],
      turnIndex: index
    }));
    base.responseInputItems = responseInputItemsFromHistory(base.history);
    base.rollout = session.turns.flatMap((turn, index) => rolloutEntriesFromEvents(turn.events ?? [], {
      turnIndex: index
    }));
  }

  return base;
}

export function createTurnRecord(options = {}) {
  const events = Array.isArray(options.events) ? options.events : [];
  const items = itemsFromEvents(events);
  const history = historyEntriesFromTurn({
    input: options.input,
    events,
    turnIndex: options.turnIndex
  });

  return {
    input: options.input,
    startedAt: options.startedAt ?? firstEventTime(events) ?? new Date().toISOString(),
    completedAt: options.completedAt ?? new Date().toISOString(),
    failed: events.some((event) => event.type === EVENT_TYPES.TURN_FAILED),
    events,
    items,
    history,
    responseInputItems: responseInputItemsFromHistory(history),
    rollout: rolloutEntriesFromEvents(events, {
      turnIndex: options.turnIndex
    })
  };
}

export function appendTurnToSession(session, turn, options = {}) {
  const normalized = normalizeSessionRecord(session, options);
  const turnRecord = createTurnRecord({
    ...turn,
    turnIndex: normalized.turns.length
  });
  const history = [
    ...normalized.history,
    ...turnRecord.history
  ];
  const compact = compactHistoryIfNeeded(history, options.compaction ?? {});
  const visibleHistory = compact.compacted
    ? [
        compact.summaryEntry,
        ...compact.visibleHistory
      ]
    : history;

  return createSessionRecord({
    ...normalized,
    updatedAt: new Date().toISOString(),
    turns: [
      ...normalized.turns,
      turnRecord
    ],
    history,
    responseInputItems: responseInputItemsFromHistory(visibleHistory),
    rollout: [
      ...normalized.rollout,
      ...turnRecord.rollout
    ],
    compact: compact.compacted
      ? compact
      : normalized.compact
  });
}

export function rollbackSessionTurns(session, options = {}) {
  const normalized = normalizeSessionRecord(session);
  const dropLastTurns = Math.max(1, Math.floor(Number(options.dropLastTurns ?? 1)));
  const turns = normalized.turns.slice(0, Math.max(0, normalized.turns.length - dropLastTurns));
  const history = turns.flatMap((turn, index) => historyEntriesFromTurn({
    input: turn.input,
    events: turn.events ?? [],
    turnIndex: index
  }));
  const rollout = turns.flatMap((turn, index) => rolloutEntriesFromEvents(turn.events ?? [], {
    turnIndex: index
  }));

  return createSessionRecord({
    ...normalized,
    updatedAt: new Date().toISOString(),
    turns,
    history,
    responseInputItems: responseInputItemsFromHistory(history),
    rollout,
    compact: null,
    metadata: {
      ...(normalized.metadata ?? {}),
      rollback: {
        droppedTurns: normalized.turns.length - turns.length,
        createdAt: new Date().toISOString()
      }
    }
  });
}

export function injectResponseItemsToSession(session, items = [], options = {}) {
  const normalized = normalizeSessionRecord(session, options);
  const responseItems = normalizeResponseItems(items);
  const injectedAt = options.injectedAt ?? new Date().toISOString();
  const historyEntries = responseItems.map((item, index) => ({
    type: HISTORY_ENTRY_TYPES.INJECTED_RESPONSE_ITEM,
    role: item.role ?? inferInjectedItemRole(item),
    text: responseItemToText(item),
    item,
    responseInputItem: item,
    injectedAt,
    injectionIndex: index,
    turnIndex: null
  }));
  const history = [
    ...normalized.history,
    ...historyEntries
  ];
  const compact = compactHistoryIfNeeded(history, options.compaction ?? {});
  const visibleHistory = compact.compacted
    ? [
        compact.summaryEntry,
        ...compact.visibleHistory
      ]
    : history;

  return createSessionRecord({
    ...normalized,
    updatedAt: injectedAt,
    history,
    responseInputItems: responseInputItemsFromHistory(visibleHistory),
    rollout: [
      ...normalized.rollout,
      ...responseItems.map((item, index) => ({
        turnIndex: null,
        eventIndex: null,
        type: "thread.injected_item",
        itemId: item.id ?? null,
        itemType: item.type ?? null,
        injectionIndex: index,
        timestamp: injectedAt
      }))
    ],
    compact: compact.compacted
      ? compact
      : normalized.compact,
    metadata: {
      ...(normalized.metadata ?? {}),
      lastInjectedAt: injectedAt
    }
  });
}

export function historyEntriesFromTurn(options = {}) {
  const entries = [];
  const input = normalizeUserInput(options.input ?? "");
  const inputText = userInputToText(input);
  const turnIndex = options.turnIndex ?? null;

  if (inputText) {
    entries.push({
      type: HISTORY_ENTRY_TYPES.USER_INPUT,
      role: MESSAGE_ROLES.USER,
      text: inputText,
      input,
      turnIndex
    });
  }

  for (const item of itemsFromEvents(options.events ?? [])) {
    const entry = historyEntryFromItem(item, {
      turnIndex
    });

    if (entry) {
      entries.push(entry);
    }
  }

  for (const event of options.events ?? []) {
    if (event.type === EVENT_TYPES.TURN_FAILED || event.type === EVENT_TYPES.ERROR) {
      entries.push({
        type: HISTORY_ENTRY_TYPES.ERROR,
        role: "system",
        text: event.error?.message ?? event.message ?? "turn failed",
        event,
        turnIndex
      });
    }
  }

  return entries;
}

export function historyEntryFromItem(item, options = {}) {
  const text = getItemText(item);
  const base = {
    itemId: item.id,
    item,
    text,
    turnIndex: options.turnIndex ?? null
  };

  if (item.type === ITEM_TYPES.MESSAGE && item.role === MESSAGE_ROLES.USER) {
    return null;
  }

  if (item.type === ITEM_TYPES.MESSAGE && item.role === MESSAGE_ROLES.ASSISTANT) {
    return {
      ...base,
      type: HISTORY_ENTRY_TYPES.ASSISTANT_MESSAGE,
      role: MESSAGE_ROLES.ASSISTANT
    };
  }

  if (item.type === ITEM_TYPES.REASONING) {
    return {
      ...base,
      type: HISTORY_ENTRY_TYPES.REASONING,
      role: "assistant"
    };
  }

  if (item.type === ITEM_TYPES.TOOL_CALL) {
    return {
      ...base,
      type: HISTORY_ENTRY_TYPES.TOOL_CALL,
      role: "tool",
      callId: item.call_id,
      name: item.name
    };
  }

  if (item.type === ITEM_TYPES.TOOL_RESULT) {
    return {
      ...base,
      type: HISTORY_ENTRY_TYPES.TOOL_RESULT,
      role: "tool",
      callId: item.call_id,
      name: item.name,
      responseInputItem: item.response_input_item ?? null
    };
  }

  if (item.type === ITEM_TYPES.COMMAND_EXECUTION) {
    return {
      ...base,
      type: HISTORY_ENTRY_TYPES.COMMAND_EXECUTION,
      role: "tool",
      command: item.command,
      cwd: item.cwd,
      exitCode: item.exit_code
    };
  }

  return null;
}

export function responseInputItemsFromHistory(history = []) {
  const items = [];

  for (const entry of history) {
    if (entry.type === HISTORY_ENTRY_TYPES.USER_INPUT) {
      items.push(createResponseInputMessageItem({
        role: MESSAGE_ROLES.USER,
        text: entry.text
      }));
    } else if (entry.type === HISTORY_ENTRY_TYPES.ASSISTANT_MESSAGE) {
      items.push({
        type: RESPONSE_INPUT_ITEM_TYPES.MESSAGE,
        role: MESSAGE_ROLES.ASSISTANT,
        content: [
          {
            type: "input_text",
            text: entry.text
          }
        ]
      });
    } else if (entry.type === HISTORY_ENTRY_TYPES.TOOL_RESULT && entry.responseInputItem) {
      items.push(entry.responseInputItem);
    } else if (entry.type === HISTORY_ENTRY_TYPES.INJECTED_RESPONSE_ITEM && entry.responseInputItem) {
      items.push(entry.responseInputItem);
    } else if (entry.type === HISTORY_ENTRY_TYPES.COMPACT_SUMMARY) {
      items.push(createResponseInputMessageItem({
        role: "system",
        text: entry.text
      }));
    }
  }

  return items;
}

export function itemsFromEvents(events = []) {
  const items = [];

  for (const event of events) {
    if (event.item) {
      upsertItem(items, event.item);
    }
  }

  return items;
}

export function rolloutEntriesFromEvents(events = [], options = {}) {
  return events.map((event, index) => ({
    turnIndex: options.turnIndex ?? null,
    eventIndex: index,
    type: event.type,
    itemId: event.item?.id ?? null,
    timestamp: event.timestamp ?? null
  }));
}

export function compactHistoryIfNeeded(history = [], options = {}) {
  const maxEntries = options.maxEntries ?? null;

  if (!maxEntries || history.length <= maxEntries) {
    return {
      compacted: false,
      visibleHistory: history,
      hiddenHistory: [],
      summaryEntry: null
    };
  }

  const keepEntries = Math.max(1, options.keepEntries ?? maxEntries);
  const visibleHistory = history.slice(-keepEntries);
  const hiddenHistory = history.slice(0, -keepEntries);
  const summaryEntry = createCompactSummaryEntry(hiddenHistory);

  return {
    compacted: true,
    strategy: "entry_count",
    maxEntries,
    keepEntries,
    hiddenCount: hiddenHistory.length,
    visibleHistory,
    hiddenHistory,
    summaryEntry
  };
}

export function createCompactSummaryEntry(hiddenHistory = []) {
  const turns = new Set(hiddenHistory
    .map((entry) => entry.turnIndex)
    .filter((value) => value != null));
  const text = [
    `Previous conversation compacted: ${hiddenHistory.length} history entries hidden.`,
    turns.size ? `Covered turns: ${Array.from(turns).join(", ")}.` : null
  ].filter(Boolean).join(" ");

  return {
    type: HISTORY_ENTRY_TYPES.COMPACT_SUMMARY,
    role: "system",
    text,
    hiddenCount: hiddenHistory.length,
    createdAt: new Date().toISOString()
  };
}

function upsertItem(items, item) {
  const index = items.findIndex((candidate) => candidate.id === item.id);

  if (index === -1) {
    items.push(item);
    return;
  }

  items[index] = item;
}

function firstEventTime(events) {
  return events.find((event) => event.timestamp)?.timestamp ?? null;
}

function inferInjectedItemRole(item) {
  if (item.role) {
    return item.role;
  }

  if (String(item.type ?? "").includes("tool")) {
    return "tool";
  }

  return "assistant";
}
