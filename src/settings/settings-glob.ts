/** Stage 10 Task 2 — pure, segment-aware settings glob matcher. */

const compiledMatchers = new Map<string, (input: string) => boolean>();

const foldAscii = (character: string): string => {
  const codePoint = character.codePointAt(0);
  if (codePoint !== undefined && codePoint >= 0x41 && codePoint <= 0x5a) {
    return String.fromCodePoint(codePoint + 0x20);
  }
  return character;
};

const segmentMatch = (pattern: readonly string[], input: readonly string[]): boolean => {
  const table: boolean[][] = Array.from({ length: pattern.length + 1 }, () =>
    Array<boolean>(input.length + 1).fill(false),
  );
  table[0]![0] = true;

  for (let patternIndex = 0; patternIndex < pattern.length; patternIndex += 1) {
    const patternCharacter = pattern[patternIndex]!;
    if (patternCharacter === "*") {
      table[patternIndex + 1]![0] = table[patternIndex]![0]!;
    }
    for (let inputIndex = 0; inputIndex < input.length; inputIndex += 1) {
      if (patternCharacter === "*") {
        table[patternIndex + 1]![inputIndex + 1] =
          table[patternIndex]![inputIndex + 1]! || table[patternIndex + 1]![inputIndex]!;
      } else if (
        patternCharacter === "?" ||
        foldAscii(patternCharacter) === foldAscii(input[inputIndex]!)
      ) {
        table[patternIndex + 1]![inputIndex + 1] = table[patternIndex]![inputIndex]!;
      }
    }
  }

  return table[pattern.length]![input.length]!;
};

const validatePattern = (pattern: string): readonly string[] => {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new TypeError("glob pattern must not be empty");
  }
  for (const character of pattern) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || codePoint > 0x7e) {
      throw new TypeError("glob pattern contains invalid characters");
    }
  }
  if (pattern.includes("//")) {
    throw new TypeError("glob pattern must not contain empty segments");
  }
  return pattern.split("/");
};

export const compileGlob = (pattern: string): ((input: string) => boolean) => {
  const existing = compiledMatchers.get(pattern);
  if (existing !== undefined) {
    return existing;
  }

  const segments = validatePattern(pattern).map((segment) => Array.from(segment));
  const matcher = (input: string): boolean => {
    if (typeof input !== "string") {
      return false;
    }
    const inputSegments = input.split("/");
    if (inputSegments.length !== segments.length) {
      return false;
    }
    return segments.every((segment, index) =>
      segmentMatch(segment, Array.from(inputSegments[index]!)),
    );
  };
  Object.setPrototypeOf(matcher, null);
  Object.freeze(matcher);
  compiledMatchers.set(pattern, matcher);
  return matcher;
};

export const globMatch = (pattern: string, input: string): boolean => compileGlob(pattern)(input);
