import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contract, generateLua, s, validate, type Schema } from '../../src/contract';
import { garbage, likelyValid, mutateOnce, nodeOf, patternText, Random, randomPattern, randomSchema } from '../support/fuzz';
import { Lua } from '../support/lua';

interface Case {
  value: unknown;
  /** Whether the two validators must also agree on the message, not only on the verdict. */
  exact: boolean;
}

/**
 * Runs every case through the generated Lua validator of its schema. The values travel as JSON
 * text and are decoded in Lua, which is the trip a real payload makes.
 */
async function runInLua(lua: Lua, schemas: Schema[], groups: Case[][]): Promise<string[][]> {
  const client: Record<string, Schema> = {};
  schemas.forEach((schema, index) => {
    client[`m${index + 1}`] = schema;
  });
  await lua.run(generateLua(contract({ client })));
  const encoded = groups.map((cases) => cases.map((entry) => JSON.stringify(entry.value) ?? 'null'));
  const result = await lua.call(
    `
    local groups = ...
    local out = {}
    for g = 1, #groups do
        local validator = NexusContract.client['m' .. g]
        local results = {}
        for c = 1, #groups[g] do
            local ok, problem = validator(json.decode(groups[g][c]))
            results[c] = ok and '' or problem
        end
        out[g] = results
    end
    return json.encode(out)
    `,
    encoded,
  );
  return JSON.parse(result as string) as string[][];
}

function verdict(schema: Schema, value: unknown): string {
  const result = validate(schema, value);
  return result.ok ? '' : result.error;
}

function compare(schemas: Schema[], groups: Case[][], fromLua: string[][]): void {
  schemas.forEach((schema, g) => {
    (groups[g] as Case[]).forEach((entry, c) => {
      const ts = verdict(schema, entry.value);
      const lua = (fromLua[g] as string[])[c] as string;
      const context = `schema ${JSON.stringify(schema)}\nvalue ${JSON.stringify(entry.value)}`;
      if (entry.exact) expect(lua, context).toBe(ts);
      else expect(lua === '', context).toBe(ts === '');
    });
  });
}

describe('TypeScript and Lua validation agree', () => {
  let lua: Lua;

  beforeAll(async () => {
    lua = await Lua.create();
  });

  afterAll(() => lua.close());

  it.each([1, 2, 3, 4, 5, 6])('on random schemas and values (seed %i)', async (seed) => {
    const random = new Random(seed);
    const schemas: Schema[] = [];
    const groups: Case[][] = [];
    let accepted = 0;
    let refused = 0;

    for (let i = 0; i < 120; i++) {
      const schema = randomSchema(random, 3);
      const node = nodeOf(schema);
      const cases: Case[] = [];
      for (let j = 0; j < 12; j++) {
        const base = likelyValid(random, node);
        const baseIsValid = validate(schema, base).ok;
        cases.push({ value: base, exact: baseIsValid });
        for (let k = 0; k < 3; k++) cases.push({ value: mutateOnce(random, node, base), exact: baseIsValid });
        cases.push({ value: garbage(random, 3), exact: false });
      }
      for (const entry of cases) {
        if (validate(schema, entry.value).ok) accepted++;
        else refused++;
      }
      schemas.push(schema);
      groups.push(cases);
    }

    compare(schemas, groups, await runInLua(lua, schemas, groups));
    // The run only means something if it saw plenty of both outcomes.
    expect(accepted).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(1000);
  });

  it.each([11, 12, 13])('on random patterns against the real regular expression (seed %i)', async (seed) => {
    const random = new Random(seed);
    const schemas: Schema[] = [];
    const groups: Case[][] = [];
    let matched = 0;

    for (let i = 0; i < 250; i++) {
      const source = randomPattern(random);
      const regex = new RegExp(source);
      const schema = s.string({ pattern: source });
      const cases: Case[] = [];
      for (let j = 0; j < 40; j++) {
        const text = j % 2 === 0 ? patternText(random) : (likelyValid(random, nodeOf(schema)) as string);
        if (regex.test(text)) matched++;
        cases.push({ value: text, exact: true });
      }
      schemas.push(schema);
      groups.push(cases);
    }

    compare(schemas, groups, await runInLua(lua, schemas, groups));
    expect(matched).toBeGreaterThan(2000);
  });
});
