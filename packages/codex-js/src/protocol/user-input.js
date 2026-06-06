export const MAX_USER_INPUT_TEXT_CHARS = 1 << 20;

export const USER_INPUT_TYPES = Object.freeze({
  TEXT: "text",
  IMAGE: "image",
  LOCAL_IMAGE: "local_image",
  SKILL: "skill",
  MENTION: "mention"
});

export function createTextInput(text, options = {}) {
  const normalizedText = String(text ?? "");

  if (normalizedText.length > MAX_USER_INPUT_TEXT_CHARS) {
    throw new RangeError(
      `User input text exceeds ${MAX_USER_INPUT_TEXT_CHARS} characters.`
    );
  }

  return {
    type: USER_INPUT_TYPES.TEXT,
    text: normalizedText,
    text_elements: options.textElements ?? []
  };
}

export function createImageInput(imageUrl, options = {}) {
  return removeUndefined({
    type: USER_INPUT_TYPES.IMAGE,
    image_url: String(imageUrl),
    detail: options.detail
  });
}

export function createLocalImageInput(path, options = {}) {
  return removeUndefined({
    type: USER_INPUT_TYPES.LOCAL_IMAGE,
    path: String(path),
    detail: options.detail
  });
}

export function createSkillInput(name, path) {
  return {
    type: USER_INPUT_TYPES.SKILL,
    name: String(name),
    path: String(path)
  };
}

export function createMentionInput(name, path) {
  return {
    type: USER_INPUT_TYPES.MENTION,
    name: String(name),
    path: String(path)
  };
}

export function normalizeUserInput(input) {
  if (Array.isArray(input)) {
    return input.flatMap((entry) => normalizeUserInput(entry));
  }

  if (typeof input === "string" || input == null) {
    return [createTextInput(input ?? "")];
  }

  if (isUserInput(input)) {
    return [input];
  }

  if (input.type === "local_image") {
    return [createLocalImageInput(input.path, { detail: input.detail })];
  }

  throw new TypeError(`Unsupported user input entry: ${JSON.stringify(input)}`);
}

export function userInputToText(input) {
  return normalizeUserInput(input).map((entry) => {
    switch (entry.type) {
      case USER_INPUT_TYPES.TEXT:
        return entry.text;
      case USER_INPUT_TYPES.IMAGE:
        return `[image: ${entry.image_url}]`;
      case USER_INPUT_TYPES.LOCAL_IMAGE:
        return `[image: ${entry.path}]`;
      case USER_INPUT_TYPES.SKILL:
        return `[skill: ${entry.name}]`;
      case USER_INPUT_TYPES.MENTION:
        return `[mention: ${entry.name}]`;
      default:
        return JSON.stringify(entry);
    }
  }).join("\n");
}

export function isUserInput(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.values(USER_INPUT_TYPES).includes(value.type)
  );
}

function removeUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}
