import { LineCounter, isAlias, parseAllDocuments, visit } from "yaml";
import { assertPlainJson } from "./plain-json.js";

function locatedMessage(label: string, error: { message: string; linePos?: readonly { line: number; col: number }[] }): string {
  const position = error.linePos?.[0];
  return position === undefined ? `${label}: ${error.message}` : `${label}:${position.line}:${position.col}: ${error.message}`;
}

export function parseSingleYamlDocument(source: string, label: string): unknown {
  if (typeof source !== "string") throw new TypeError(`${label}: YAML source must be a string`);
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(source, {
    version: "1.2",
    schema: "core",
    strict: true,
    uniqueKeys: true,
    merge: false,
    customTags: [],
    lineCounter,
    prettyErrors: true
  });
  if (documents.length !== 1) throw new SyntaxError(`${label}: expected exactly one YAML document, found ${documents.length}`);
  const document = documents[0]!;
  if (document.errors.length > 0) throw new SyntaxError(locatedMessage(label, document.errors[0]!));
  if (document.warnings.length > 0) throw new SyntaxError(locatedMessage(label, document.warnings[0]!));

  let aliasOffset: number | undefined;
  visit(document, (_key, node) => {
    if (isAlias(node)) {
      aliasOffset = node.range?.[0];
      return visit.BREAK;
    }
    return undefined;
  });
  if (aliasOffset !== undefined) {
    const position = lineCounter.linePos(aliasOffset);
    throw new SyntaxError(`${label}:${position.line}:${position.col}: YAML aliases are not allowed`);
  }

  const value = document.toJS({ maxAliasCount: 0 });
  assertPlainJson(value, label);
  return value;
}
