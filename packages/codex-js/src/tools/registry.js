export const TOOL_SPEC_TYPES = Object.freeze({
  FUNCTION: "function"
});

export class ToolRegistry {
  constructor(options = {}) {
    this.tools = new Map();

    for (const tool of options.tools ?? []) {
      this.register(tool);
    }
  }

  static empty() {
    return new ToolRegistry();
  }

  register(tool) {
    const entry = normalizeToolEntry(tool);

    if (this.tools.has(entry.name)) {
      throw new Error(`Tool already registered: ${entry.name}`);
    }

    this.tools.set(entry.name, entry);
    return entry;
  }

  unregister(name) {
    return this.tools.delete(normalizeToolName(name));
  }

  has(name) {
    return this.tools.has(normalizeToolName(name));
  }

  get(name) {
    return this.tools.get(normalizeToolName(name)) ?? null;
  }

  list() {
    return Array.from(this.tools.values()).map((entry) => ({
      ...entry,
      spec: { ...entry.spec }
    }));
  }

  modelVisibleSpecs() {
    return this.list()
      .filter((entry) => {
        const exposure = entry.metadata?.exposure ?? "model_visible";

        return exposure === "model_visible";
      })
      .map((entry) => entry.spec);
  }
}

export function normalizeToolEntry(tool) {
  if (!tool || typeof tool !== "object") {
    throw new TypeError("Tool entry must be an object.");
  }

  const spec = normalizeToolSpec(tool.spec ?? tool);

  return {
    name: spec.name,
    spec,
    handler: tool.handler ?? null,
    metadata: tool.metadata ?? null
  };
}

export function normalizeToolSpec(spec) {
  if (!spec || typeof spec !== "object") {
    throw new TypeError("Tool spec must be an object.");
  }

  const name = normalizeToolName(spec.name);
  const outputSchema = spec.outputSchema ?? spec.output_schema ?? null;
  const normalized = {
    ...spec,
    type: spec.type ?? TOOL_SPEC_TYPES.FUNCTION,
    name,
    description: String(spec.description ?? ""),
    strict: Boolean(spec.strict ?? false),
    parameters: spec.parameters ?? {},
    output_schema: outputSchema
  };

  delete normalized.outputSchema;
  return normalized;
}

export function normalizeToolName(name) {
  const normalized = String(name ?? "").trim();

  if (!normalized) {
    throw new Error("Tool name is required.");
  }

  return normalized;
}
