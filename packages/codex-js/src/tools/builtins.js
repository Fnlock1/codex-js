import { BUILTIN_TOOL_NAMES } from "./runtime.js";

export const BUILTIN_TOOL_CATEGORIES = Object.freeze({
  EXEC: "exec",
  FILE_EDIT: "file_edit",
  PERMISSION: "permission",
  HOSTED: "hosted",
  MCP: "mcp",
  SUB_AGENT: "sub_agent",
  GOAL: "goal",
  PLACEHOLDER: "placeholder"
});

export const TOOL_EXPOSURE = Object.freeze({
  MODEL_VISIBLE: "model_visible",
  DEFERRED: "deferred",
  HIDDEN: "hidden"
});

function functionToolSpec(name, description, parameters = {}, options = {}) {
  return {
    type: "function",
    name,
    description,
    strict: Boolean(options.strict ?? false),
    parameters: {
      type: "object",
      properties: parameters.properties ?? {},
      required: parameters.required ?? [],
      additionalProperties: parameters.additionalProperties ?? false
    },
    output_schema: options.outputSchema ?? options.output_schema ?? null
  };
}

export function createShellCommandToolSpec() {
  return {
    type: "function",
    name: BUILTIN_TOOL_NAMES.SHELL_COMMAND,
    description: "Run a shell command through the configured exec runtime.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        command: {
          description: "Command string or argv array to run.",
          oneOf: [
            {
              type: "string"
            },
            {
              type: "array",
              items: {
                type: "string"
              }
            }
          ]
        },
        cwd: {
          type: "string",
          description: "Working directory for the command."
        },
        timeout_ms: {
          type: "number",
          description: "Optional command timeout in milliseconds."
        }
      },
      required: ["command"],
      additionalProperties: true
    }
  };
}

export function createExecToolSpec() {
  return {
    ...createShellCommandToolSpec(),
    name: BUILTIN_TOOL_NAMES.EXEC,
    description: "Run a non-interactive command through the configured exec runtime."
  };
}

export function createExecCommandToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.EXEC_COMMAND,
    "Runs a command in a PTY-like exec session and returns output or a session id for ongoing interaction.",
    {
      properties: {
        cmd: {
          type: "string",
          description: "Shell command to execute."
        },
        workdir: {
          type: "string",
          description: "Working directory for the command. Defaults to the turn cwd."
        },
        tty: {
          type: "boolean",
          description: "True allocates a PTY; false or omitted uses plain pipes."
        },
        yield_time_ms: {
          type: "number",
          description: "Wait before yielding output."
        },
        max_output_tokens: {
          type: "number",
          description: "Output token budget."
        }
      },
      required: ["cmd"],
      additionalProperties: true
    },
    {
      outputSchema: createUnifiedExecOutputSchema()
    }
  );
}

export function createWriteStdinToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.WRITE_STDIN,
    "Writes characters to an existing exec session and returns recent output.",
    {
      properties: {
        session_id: {
          type: "number",
          description: "Identifier of the running exec session."
        },
        chars: {
          type: "string",
          description: "Bytes to write to stdin. Empty input polls without writing."
        },
        yield_time_ms: {
          type: "number",
          description: "Wait before yielding output."
        },
        max_output_tokens: {
          type: "number",
          description: "Output token budget."
        }
      },
      required: ["session_id"],
      additionalProperties: false
    },
    {
      outputSchema: createUnifiedExecOutputSchema()
    }
  );
}

export function createApplyPatchToolSpec() {
  return {
    type: "function",
    name: BUILTIN_TOOL_NAMES.APPLY_PATCH,
    description: "Parse, preview, or apply a Codex apply_patch patch. The patch field must contain the full patch text; natural-language instructions are invalid.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "Full patch text beginning with *** Begin Patch and ending with *** End Patch. For new files use *** Add File: path and prefix every content line with +."
        }
      },
      required: ["patch"],
      additionalProperties: false
    }
  };
}

export function createReadFileToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.READ_FILE,
    "Read a UTF-8 text file from the workspace.",
    {
      properties: {
        path: {
          type: "string",
          description: "File path to read."
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  );
}

export function createListFilesToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.LIST_FILES,
    "List files in a directory.",
    {
      properties: {
        path: {
          type: "string",
          description: "Directory path to list. Defaults to the workspace."
        },
        recursive: {
          type: "boolean",
          description: "Whether to recursively list directories."
        },
        limit: {
          type: "number",
          description: "Maximum number of entries."
        }
      },
      additionalProperties: false
    }
  );
}

export function createSearchFilesToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.SEARCH_FILES,
    "Search UTF-8 text files for a literal query.",
    {
      properties: {
        query: {
          type: "string",
          description: "Literal text to search for."
        },
        path: {
          type: "string",
          description: "Directory path to search. Defaults to the workspace."
        },
        limit: {
          type: "number",
          description: "Maximum number of matches."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  );
}

export function createGitStatusToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.GIT_STATUS,
    "Show git status for the workspace.",
    {
      properties: {
        cwd: {
          type: "string",
          description: "Repository directory. Defaults to the turn working directory."
        }
      },
      additionalProperties: false
    }
  );
}

export function createGitDiffToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.GIT_DIFF,
    "Show git diff for the workspace.",
    {
      properties: {
        cwd: {
          type: "string",
          description: "Repository directory. Defaults to the turn working directory."
        },
        staged: {
          type: "boolean",
          description: "Show staged diff instead of working tree diff."
        },
        path: {
          type: "string",
          description: "Optional pathspec to diff."
        }
      },
      additionalProperties: false
    }
  );
}

export function createRequestPermissionsToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.REQUEST_PERMISSIONS,
    "Request additional filesystem or network permissions from the user.",
    {
      properties: {
        reason: {
          type: "string",
          description: "Optional short explanation for why additional permissions are needed."
        },
        environment_id: {
          type: "string",
          description: "Environment id from environment context."
        },
        permissions: createPermissionProfileSchema()
      },
      required: ["permissions"],
      additionalProperties: false
    }
  );
}

export function createViewImageToolSpec(options = {}) {
  const properties = {
    path: {
      type: "string",
      description: "Local filesystem path to an image file."
    }
  };

  if (options.canRequestOriginalImageDetail ?? true) {
    properties.detail = {
      type: "string",
      enum: ["high", "original"],
      description: "Image detail level. Defaults to high; use original to preserve exact resolution."
    };
  }

  if (options.includeEnvironmentId ?? false) {
    properties.environment_id = {
      type: "string",
      description: "Environment id from environment context."
    };
  }

  return functionToolSpec(
    BUILTIN_TOOL_NAMES.VIEW_IMAGE,
    "View a local image file from the filesystem when visual inspection is needed.",
    {
      properties,
      required: ["path"],
      additionalProperties: false
    },
    {
      outputSchema: {
        type: "object",
        properties: {
          image_url: {
            type: "string",
            description: "Data URL for the loaded image."
          },
          detail: {
            type: "string",
            enum: ["high", "original"]
          }
        },
        required: ["image_url", "detail"],
        additionalProperties: false
      }
    }
  );
}

export function createWebSearchToolSpec(options = {}) {
  return {
    type: "web_search",
    name: BUILTIN_TOOL_NAMES.WEB_SEARCH,
    description: "Search the web through a hosted search capability.",
    external_web_access: options.externalWebAccess ?? false,
    filters: options.filters ?? null,
    user_location: options.userLocation ?? null,
    search_context_size: options.searchContextSize ?? null,
    search_content_types: options.searchContentTypes ?? null
  };
}

export function createImageGenerationToolSpec(options = {}) {
  return {
    type: "image_generation",
    name: BUILTIN_TOOL_NAMES.IMAGE_GENERATION,
    description: "Generate images through a hosted image generation capability.",
    output_format: options.outputFormat ?? "png"
  };
}

export function createToolSearchToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.TOOL_SEARCH,
    "Search over deferred tool metadata and expose matching tools.",
    {
      properties: {
        query: {
          type: "string",
          description: "Search query for deferred tools."
        },
        limit: {
          type: "number",
          description: "Maximum number of tools to return."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  );
}

export function createListMcpResourcesToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.LIST_MCP_RESOURCES,
    "List resources provided by configured MCP servers.",
    {
      properties: {
        server: {
          type: "string",
          description: "Optional MCP server name."
        },
        cursor: {
          type: "string",
          description: "Opaque pagination cursor."
        }
      },
      additionalProperties: false
    }
  );
}

export function createListMcpResourceTemplatesToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.LIST_MCP_RESOURCE_TEMPLATES,
    "List resource templates provided by configured MCP servers.",
    {
      properties: {
        server: {
          type: "string",
          description: "Optional MCP server name."
        },
        cursor: {
          type: "string",
          description: "Opaque pagination cursor."
        }
      },
      additionalProperties: false
    }
  );
}

export function createReadMcpResourceToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.READ_MCP_RESOURCE,
    "Read a specific MCP resource by server and URI.",
    {
      properties: {
        server: {
          type: "string",
          description: "MCP server name."
        },
        uri: {
          type: "string",
          description: "Resource URI to read."
        }
      },
      required: ["server", "uri"],
      additionalProperties: false
    }
  );
}

export function createSpawnAgentToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.SPAWN_AGENT,
    "Spawn a sub-agent task.",
    {
      properties: {
        task: {
          type: "string",
          description: "Task for the sub-agent."
        },
        context: {
          type: "string",
          description: "Optional context for the sub-agent."
        }
      },
      required: ["task"],
      additionalProperties: true
    }
  );
}

export function createWaitAgentToolSpec() {
  return functionToolSpec(
    BUILTIN_TOOL_NAMES.WAIT_AGENT,
    "Wait for a previously spawned sub-agent task.",
    {
      properties: {
        agent_id: {
          type: "string",
          description: "Sub-agent identifier."
        }
      },
      required: ["agent_id"],
      additionalProperties: false
    }
  );
}

export function createGoalToolSpec(name = BUILTIN_TOOL_NAMES.GET_GOAL) {
  const descriptions = {
    [BUILTIN_TOOL_NAMES.GET_GOAL]: "Get the current thread goal.",
    [BUILTIN_TOOL_NAMES.CREATE_GOAL]: "Create a new thread goal.",
    [BUILTIN_TOOL_NAMES.UPDATE_GOAL]: "Update the current thread goal."
  };

  return functionToolSpec(
    name,
    descriptions[name] ?? "Manage thread goal state.",
    {
      properties: {
        objective: {
          type: "string",
          description: "Goal objective."
        },
        status: {
          type: "string",
          description: "Goal status."
        },
        token_budget: {
          type: "number",
          description: "Optional goal token budget."
        }
      },
      additionalProperties: false
    }
  );
}

function createUnifiedExecOutputSchema() {
  return {
    type: "object",
    properties: {
      chunk_id: {
        type: "string"
      },
      wall_time_seconds: {
        type: "number"
      },
      exit_code: {
        type: "number"
      },
      session_id: {
        type: "number"
      },
      original_token_count: {
        type: "number"
      },
      output: {
        type: "string"
      }
    },
    required: ["wall_time_seconds", "output"],
    additionalProperties: false
  };
}

function createPermissionProfileSchema() {
  return {
    type: "object",
    description: "Filesystem or network access request.",
    properties: {
      network: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean"
          }
        },
        additionalProperties: false
      },
      file_system: {
        type: "object",
        properties: {
          read: {
            type: "array",
            items: {
              type: "string"
            }
          },
          write: {
            type: "array",
            items: {
              type: "string"
            }
          }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  };
}

function placeholderDefinition(name, spec, category, options = {}) {
  return {
    name,
    spec,
    metadata: {
      category,
      exposure: options.exposure ?? TOOL_EXPOSURE.MODEL_VISIBLE,
      requiresApproval: Boolean(options.requiresApproval ?? false),
      requiresSandbox: Boolean(options.requiresSandbox ?? false),
      approvalHandledBy: options.approvalHandledBy,
      sandboxHandledBy: options.sandboxHandledBy,
      safePlaceholder: true
    },
    handler: options.handler
  };
}

export function createBuiltinToolDefinitions(options = {}) {
  const placeholderHandler = options.placeholderHandler;
  const definitions = [
    {
      name: BUILTIN_TOOL_NAMES.SHELL_COMMAND,
      spec: createShellCommandToolSpec(),
      metadata: {
        category: BUILTIN_TOOL_CATEGORIES.EXEC,
        requiresApproval: true,
        requiresSandbox: true,
        approvalHandledBy: "handler",
        sandboxHandledBy: "handler"
      },
      handler: options.shellCommandHandler
    },
    {
      name: BUILTIN_TOOL_NAMES.EXEC,
      spec: createExecToolSpec(),
      metadata: {
        category: BUILTIN_TOOL_CATEGORIES.EXEC,
        requiresApproval: true,
        requiresSandbox: true,
        approvalHandledBy: "handler",
        sandboxHandledBy: "handler"
      },
      handler: options.execHandler
    },
    {
      name: BUILTIN_TOOL_NAMES.EXEC_COMMAND,
      spec: createExecCommandToolSpec(),
      metadata: {
        category: BUILTIN_TOOL_CATEGORIES.EXEC,
        requiresApproval: true,
        requiresSandbox: true,
        approvalHandledBy: "handler",
        sandboxHandledBy: "handler"
      },
      handler: options.execCommandHandler ?? options.execHandler
    },
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.WRITE_STDIN,
      createWriteStdinToolSpec(),
      BUILTIN_TOOL_CATEGORIES.EXEC,
      {
        requiresApproval: true,
        requiresSandbox: true,
        handler: options.writeStdinHandler ?? placeholderHandler
      }
    ),
    {
      name: BUILTIN_TOOL_NAMES.APPLY_PATCH,
      spec: createApplyPatchToolSpec(),
      metadata: {
        category: BUILTIN_TOOL_CATEGORIES.FILE_EDIT,
        requiresApproval: true,
        requiresSandbox: true,
        approvalHandledBy: "handler",
        sandboxHandledBy: "handler"
      },
      handler: options.applyPatchHandler
    },
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.READ_FILE,
      createReadFileToolSpec(),
      BUILTIN_TOOL_CATEGORIES.FILE_EDIT,
      {
        requiresSandbox: true,
        handler: options.readFileHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.LIST_FILES,
      createListFilesToolSpec(),
      BUILTIN_TOOL_CATEGORIES.FILE_EDIT,
      {
        requiresSandbox: true,
        handler: options.listFilesHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.SEARCH_FILES,
      createSearchFilesToolSpec(),
      BUILTIN_TOOL_CATEGORIES.FILE_EDIT,
      {
        requiresSandbox: true,
        handler: options.searchFilesHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.GIT_STATUS,
      createGitStatusToolSpec(),
      BUILTIN_TOOL_CATEGORIES.EXEC,
      {
        requiresApproval: true,
        requiresSandbox: true,
        approvalHandledBy: "handler",
        sandboxHandledBy: "handler",
        handler: options.gitStatusHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.GIT_DIFF,
      createGitDiffToolSpec(),
      BUILTIN_TOOL_CATEGORIES.EXEC,
      {
        requiresApproval: true,
        requiresSandbox: true,
        approvalHandledBy: "handler",
        sandboxHandledBy: "handler",
        handler: options.gitDiffHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.REQUEST_PERMISSIONS,
      createRequestPermissionsToolSpec(),
      BUILTIN_TOOL_CATEGORIES.PERMISSION,
      {
        requiresApproval: true,
        approvalHandledBy: "handler",
        handler: options.requestPermissionsHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.VIEW_IMAGE,
      createViewImageToolSpec(options.viewImageOptions),
      BUILTIN_TOOL_CATEGORIES.HOSTED,
      {
        requiresSandbox: true,
        handler: options.viewImageHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.TOOL_SEARCH,
      createToolSearchToolSpec(),
      BUILTIN_TOOL_CATEGORIES.PLACEHOLDER,
      {
        exposure: TOOL_EXPOSURE.DEFERRED,
        handler: options.toolSearchHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.LIST_MCP_RESOURCES,
      createListMcpResourcesToolSpec(),
      BUILTIN_TOOL_CATEGORIES.MCP,
      {
        exposure: TOOL_EXPOSURE.DEFERRED,
        requiresApproval: true,
        handler: options.listMcpResourcesHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.LIST_MCP_RESOURCE_TEMPLATES,
      createListMcpResourceTemplatesToolSpec(),
      BUILTIN_TOOL_CATEGORIES.MCP,
      {
        exposure: TOOL_EXPOSURE.DEFERRED,
        requiresApproval: true,
        handler: options.listMcpResourceTemplatesHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.READ_MCP_RESOURCE,
      createReadMcpResourceToolSpec(),
      BUILTIN_TOOL_CATEGORIES.MCP,
      {
        exposure: TOOL_EXPOSURE.DEFERRED,
        requiresApproval: true,
        handler: options.readMcpResourceHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.SPAWN_AGENT,
      createSpawnAgentToolSpec(),
      BUILTIN_TOOL_CATEGORIES.SUB_AGENT,
      {
        exposure: TOOL_EXPOSURE.DEFERRED,
        requiresApproval: true,
        handler: options.spawnAgentHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.WAIT_AGENT,
      createWaitAgentToolSpec(),
      BUILTIN_TOOL_CATEGORIES.SUB_AGENT,
      {
        exposure: TOOL_EXPOSURE.DEFERRED,
        handler: options.waitAgentHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.GET_GOAL,
      createGoalToolSpec(BUILTIN_TOOL_NAMES.GET_GOAL),
      BUILTIN_TOOL_CATEGORIES.GOAL,
      {
        exposure: TOOL_EXPOSURE.HIDDEN,
        handler: options.getGoalHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.CREATE_GOAL,
      createGoalToolSpec(BUILTIN_TOOL_NAMES.CREATE_GOAL),
      BUILTIN_TOOL_CATEGORIES.GOAL,
      {
        exposure: TOOL_EXPOSURE.HIDDEN,
        handler: options.createGoalHandler ?? placeholderHandler
      }
    ),
    placeholderDefinition(
      BUILTIN_TOOL_NAMES.UPDATE_GOAL,
      createGoalToolSpec(BUILTIN_TOOL_NAMES.UPDATE_GOAL),
      BUILTIN_TOOL_CATEGORIES.GOAL,
      {
        exposure: TOOL_EXPOSURE.HIDDEN,
        handler: options.updateGoalHandler ?? placeholderHandler
      }
    )
  ];

  if (options.includeHostedTools ?? false) {
    definitions.push(
      placeholderDefinition(
        BUILTIN_TOOL_NAMES.WEB_SEARCH,
        createWebSearchToolSpec(options.webSearchOptions),
        BUILTIN_TOOL_CATEGORIES.HOSTED,
        {
          requiresApproval: true,
          handler: options.webSearchHandler ?? placeholderHandler
        }
      ),
      placeholderDefinition(
        BUILTIN_TOOL_NAMES.IMAGE_GENERATION,
        createImageGenerationToolSpec(options.imageGenerationOptions),
        BUILTIN_TOOL_CATEGORIES.HOSTED,
        {
          requiresApproval: true,
          handler: options.imageGenerationHandler ?? placeholderHandler
        }
      )
    );
  }

  return definitions;
}
