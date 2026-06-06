import type { LanguageContribution, MonacoApi } from "./language-types";

const languages = new Map<string, LanguageContribution>();
const setupPromises = new Map<string, Promise<void>>();

export function registerLanguage(contribution: LanguageContribution): void {
  languages.set(contribution.id, contribution);
}

export function registeredLanguages(): LanguageContribution[] {
  return Array.from(languages.values());
}

export function languageForPath(path: string): LanguageContribution | undefined {
  const normalized = path.toLowerCase().replace(/\\/g, "/");
  const filename = normalized.split("/").at(-1) ?? normalized;

  return registeredLanguages().find((language) => {
    const matchesFilename = language.filenames?.some((item) => item.toLowerCase() === filename);
    const matchesExtension = language.extensions.some((extension) =>
      normalized.endsWith(extension.toLowerCase())
    );

    return matchesFilename || matchesExtension;
  });
}

export async function ensureLanguage(monaco: MonacoApi, path: string): Promise<string> {
  const contribution = languageForPath(path);

  if (!contribution) {
    return "plaintext";
  }

  if (!setupPromises.has(contribution.id)) {
    setupPromises.set(
      contribution.id,
      Promise.resolve(contribution.setup(monaco)).then(() => undefined)
    );
  }

  await setupPromises.get(contribution.id);
  return contribution.id;
}
