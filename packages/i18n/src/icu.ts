const SELECT_TYPES: ReadonlySet<string> = new Set(['plural', 'select', 'selectordinal']);

export class IcuSyntaxError extends Error {
  constructor(message: string, position: number) {
    super(`${message} at position ${position}`);
    this.name = 'IcuSyntaxError';
  }
}

function skipWhitespace(source: string, position: number): number {
  let cursor = position;
  while (cursor < source.length && /\s/.test(source.charAt(cursor))) {
    cursor += 1;
  }
  return cursor;
}

function readUntil(source: string, position: number, stops: string): [string, number] {
  let cursor = position;
  while (cursor < source.length && !stops.includes(source.charAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= source.length) {
    throw new IcuSyntaxError('Unterminated argument', position);
  }
  return [source.slice(position, cursor).trim(), cursor];
}

function parseMessage(
  source: string,
  position: number,
  found: Set<string>,
  nested: boolean,
): number {
  let cursor = position;
  while (cursor < source.length) {
    const char = source.charAt(cursor);
    if (char === "'") {
      const next = source.charAt(cursor + 1);
      if (next === "'") {
        cursor += 2;
      } else if ('{}#<'.includes(next) && next !== '') {
        const closing = source.indexOf("'", cursor + 1);
        cursor = closing === -1 ? source.length : closing + 1;
      } else {
        cursor += 1;
      }
    } else if (char === '{') {
      cursor = parseArgument(source, cursor + 1, found);
    } else if (char === '}') {
      if (!nested) {
        throw new IcuSyntaxError('Unexpected closing brace', cursor);
      }
      return cursor;
    } else if (char === '<') {
      const match = /^<\/?([a-zA-Z][\w-]*)>/.exec(source.slice(cursor));
      if (match?.[1] !== undefined) {
        found.add(`<${match[1]}>`);
        cursor += match[0].length;
      } else {
        cursor += 1;
      }
    } else {
      cursor += 1;
    }
  }
  if (nested) {
    throw new IcuSyntaxError('Unterminated sub-message', position);
  }
  return cursor;
}

function parseArgument(source: string, position: number, found: Set<string>): number {
  const [name, afterName] = readUntil(source, position, ',}');
  if (!/^[A-Za-z_][\w]*$/.test(name)) {
    throw new IcuSyntaxError(`Invalid argument name "${name}"`, position);
  }
  found.add(name);
  if (source.charAt(afterName) === '}') {
    return afterName + 1;
  }
  const [type, afterType] = readUntil(source, afterName + 1, ',}');
  if (source.charAt(afterType) === '}') {
    return afterType + 1;
  }
  let cursor = afterType + 1;
  if (SELECT_TYPES.has(type)) {
    let options = 0;
    for (;;) {
      cursor = skipWhitespace(source, cursor);
      if (cursor >= source.length) {
        throw new IcuSyntaxError(`Unterminated ${type}`, position);
      }
      if (source.charAt(cursor) === '}') {
        if (options === 0) {
          throw new IcuSyntaxError(`Empty ${type}`, position);
        }
        return cursor + 1;
      }
      const [selector, afterSelector] = readUntil(source, cursor, '{} \n\t');
      if (selector === '') {
        throw new IcuSyntaxError('Missing selector', cursor);
      }
      cursor = skipWhitespace(source, afterSelector);
      if (selector.startsWith('offset:')) {
        continue;
      }
      if (source.charAt(cursor) !== '{') {
        throw new IcuSyntaxError(`Expected sub-message for "${selector}"`, cursor);
      }
      cursor = parseMessage(source, cursor + 1, found, true) + 1;
      options += 1;
    }
  }
  let depth = 1;
  while (cursor < source.length && depth > 0) {
    const char = source.charAt(cursor);
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    }
    cursor += 1;
  }
  if (depth > 0) {
    throw new IcuSyntaxError('Unterminated argument style', position);
  }
  return cursor;
}

export function icuArguments(message: string): string[] {
  const found = new Set<string>();
  parseMessage(message, 0, found, false);
  return [...found].sort();
}
