export type EnumDefinition = Readonly<Record<string, string>>;

export type EnumValue<T extends EnumDefinition> = T[keyof T];

export function enumValues<const T extends EnumDefinition>(definition: T): readonly EnumValue<T>[] {
  return Object.freeze(Object.values(definition) as EnumValue<T>[]);
}

export function isEnumValue<const T extends EnumDefinition>(
  definition: T,
  value: unknown,
): value is EnumValue<T> {
  return typeof value === 'string' && Object.values(definition).includes(value);
}

export function parseEnumValue<const T extends EnumDefinition>(
  definition: T,
  value: unknown,
  enumName: string,
): EnumValue<T> {
  if (isEnumValue(definition, value)) {
    return value;
  }
  throw new RangeError(`Invalid ${enumName} value: ${JSON.stringify(value)}`);
}
