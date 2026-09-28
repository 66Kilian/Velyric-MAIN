import { createHash } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export class DeterministicIds {
  readonly #seed: string;
  readonly #counters = new Map<string, number>();
  readonly #sequenceOffset: number;

  constructor(seed: string, sequenceOffset = 0) {
    this.#seed = seed;
    this.#sequenceOffset = sequenceOffset;
  }

  #digest(prefix: string): Buffer {
    const counter = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, counter);
    return createHash('sha256')
      .update(`${this.#seed}:${prefix}:${String(counter)}`)
      .digest();
  }

  token(prefix: string, length = 24): string {
    const digest = this.#digest(prefix);
    let text = '';
    for (let index = 0; text.length < length; index += 1) {
      text += ALPHABET[(digest[index % digest.length] ?? 0) % ALPHABET.length] ?? '0';
    }
    return text;
  }

  id(prefix: string, separator = '_', length = 24): string {
    return `${prefix}${separator}${this.token(prefix, length)}`;
  }

  integer(prefix: string, min: number, max: number): number {
    const digest = this.#digest(prefix);
    return min + (digest.readUInt32BE(0) % (max - min + 1));
  }

  sequence(prefix: string): number {
    const counter = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, counter);
    return this.#sequenceOffset + counter;
  }

  uuid(prefix: string): string {
    const hex = this.#digest(prefix).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
}

export function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}
