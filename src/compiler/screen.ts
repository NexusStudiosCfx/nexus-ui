import type { Attribute, ScreenTag } from './ast';
import type { Reporter } from './diagnostics';
import { suggest } from './suggest';

/** What a `<screen>` tag declares, with defaults filled in. */
export interface ScreenDeclaration {
  /** What `SetNuiFocus` gets while the screen is open. */
  focus: { mouse: boolean; keyboard: boolean };
  /** Game input stays on (`SetNuiFocusKeepInput`). */
  keepInput: boolean;
  /** `escape`: the Escape key closes the screen. */
  close: 'escape' | 'none';
  /** Design size: the screen is scaled to fit the window and centred. */
  size: { width: number; height: number } | null;
  /** A `hud` screen takes no focus and stays under the other screens. */
  layer: 'screen' | 'hud';
  /** CSS cursor shown over the screen. */
  cursor: string | null;
  /**
   * Where the screen is shown when that is not the game's own page. `phone` and `tablet`: it is
   * the root of an app in LB Phone or LB Tablet, and has no focus, no Escape, no size and no
   * layer, because its frame belongs to LB. `world`: it is drawn on a prop by a browser of its
   * `size`, and has no focus, no Escape and no layer, because nobody uses it until Lua says so.
   * The compiler always sets it, to null for an ordinary screen. It is optional so that a
   * declaration written by hand before surfaces existed is still a valid one.
   */
  surface?: 'phone' | 'tablet' | 'world' | null;
}

const ATTRIBUTES = ['focus', 'keep-input', 'close', 'size', 'layer', 'cursor', 'surface'];

// What the frame of an app decides, and a surface screen therefore cannot.
const NOT_ON_SURFACE: Record<string, string> = {
  focus: 'takes the focus',
  'keep-input': 'takes the focus',
  close: 'is closed',
  size: 'is sized',
  layer: 'is stacked',
};

// What a screen on a prop cannot say: the game's page has the focus, not the prop.
const NOT_IN_WORLD: Record<string, string> = {
  focus: 'It takes no focus: the player uses it through `Nexus.operate`.',
  'keep-input': 'It takes no focus: the player uses it through `Nexus.operate`.',
  close: 'Nothing closes it from the page: Lua destroys its display.',
  layer: 'It is not stacked with the screens of the page.',
};

const SURFACES = '`phone`, `tablet` or `world`';

export function analyseScreen(tag: ScreenTag, reporter: Reporter): ScreenDeclaration {
  const given = new Map<string, { text: string | null; attribute: Attribute }>();
  for (const attribute of tag.attributes) {
    if (!ATTRIBUTES.includes(attribute.name)) {
      const close = suggest(attribute.name, ATTRIBUTES);
      reporter.error({
        code: 'screen-attribute',
        message: `\`<screen>\` has no \`${attribute.name}\` attribute.`,
        hint: close ? `Did you mean \`${close}\`?` : `Its attributes are ${ATTRIBUTES.map((name) => `\`${name}\``).join(', ')}.`,
        start: attribute.start,
        end: attribute.end,
      });
    }
    const text = attribute.value === true ? null : attribute.value.map((part) => (part.type === 'Text' ? part.data : '')).join('');
    given.set(attribute.name, { text: text === null ? null : text.trim(), attribute });
  }

  const invalid = (name: string, expected: string): never => {
    const { attribute } = given.get(name) as { attribute: Attribute };
    return reporter.error({
      code: 'screen-value',
      message: `\`${name}\` on \`<screen>\` must be ${expected}.`,
      hint: `For example \`${EXAMPLES[name]}\`.`,
      start: attribute.start,
      end: attribute.end,
    });
  };

  /** The value of an attribute that must have one. */
  const text = (name: string, expected: string): string | undefined => {
    const entry = given.get(name);
    if (!entry) return undefined;
    return entry.text || invalid(name, expected);
  };

  const surface = text('surface', SURFACES);
  if (surface === 'world') return analyseWorld(given, text, invalid, tag, reporter);
  if (surface !== undefined) {
    if (surface !== 'phone' && surface !== 'tablet') invalid('surface', SURFACES);
    for (const [name, { attribute }] of given) {
      const decided = NOT_ON_SURFACE[name];
      if (decided) {
        reporter.error({
          code: 'surface-attribute',
          message: `\`${name}\` has no meaning on a ${surface} app: LB ${surface === 'phone' ? 'Phone' : 'Tablet'} owns the frame and decides how it ${decided}.`,
          hint: `Remove \`${name}\`. An app fills the frame it is given.`,
          start: attribute.start,
          end: attribute.end,
        });
      }
    }
    return {
      focus: { mouse: false, keyboard: false },
      keepInput: false,
      close: 'none',
      size: null,
      layer: 'screen',
      cursor: text('cursor', 'a CSS cursor') ?? null,
      surface: surface as 'phone' | 'tablet',
    };
  }

  const layerText = text('layer', '`screen` or `hud`');
  if (layerText !== undefined && layerText !== 'screen' && layerText !== 'hud') invalid('layer', '`screen` or `hud`');
  const layer = layerText === 'hud' ? 'hud' : 'screen';

  const focus = { mouse: layer === 'screen', keyboard: layer === 'screen' };
  const focusText = text('focus', '`mouse`, `keyboard`, both, or `none`');
  if (focusText !== undefined) {
    const words = focusText.split(/\s+/);
    if (words.some((word) => word !== 'mouse' && word !== 'keyboard' && word !== 'none') || (words.includes('none') && words.length > 1)) {
      invalid('focus', '`mouse`, `keyboard`, both, or `none`');
    }
    focus.mouse = words.includes('mouse');
    focus.keyboard = words.includes('keyboard');
    if (layer === 'hud' && (focus.mouse || focus.keyboard)) {
      const { attribute } = given.get('focus') as { attribute: Attribute };
      reporter.error({
        code: 'hud-focus',
        message: 'A `hud` screen takes no focus: it is drawn under the other screens and never receives input.',
        hint: 'Remove `focus`, or remove `layer="hud"` to make this a normal screen.',
        start: attribute.start,
        end: attribute.end,
      });
    }
  }

  const keepInput = given.get('keep-input');
  if (keepInput && keepInput.text !== null) invalid('keep-input', 'written without a value');

  const closeText = text('close', '`escape` or `none`');
  if (closeText !== undefined && closeText !== 'escape' && closeText !== 'none') invalid('close', '`escape` or `none`');

  return {
    focus,
    keepInput: !!keepInput,
    // Without a way out a player with keyboard focus would be stuck, so Escape closes by default.
    close: closeText === 'escape' || closeText === 'none' ? closeText : focus.keyboard ? 'escape' : 'none',
    size: readSize(text, invalid),
    layer,
    cursor: text('cursor', 'a CSS cursor') ?? null,
    surface: null,
  };
}

type Given = Map<string, { text: string | null; attribute: Attribute }>;
type ReadText = (name: string, expected: string) => string | undefined;
type Invalid = (name: string, expected: string) => never;

function readSize(text: ReadText, invalid: Invalid): ScreenDeclaration['size'] {
  const sizeText = text('size', 'a width and a height in pixels');
  if (sizeText === undefined) return null;
  const match = /^(\d+)x(\d+)$/.exec(sizeText);
  if (!match || !+(match[1] as string) || !+(match[2] as string)) return invalid('size', 'a width and a height in pixels');
  return { width: +(match[1] as string), height: +(match[2] as string) };
}

function analyseWorld(given: Given, text: ReadText, invalid: Invalid, tag: ScreenTag, reporter: Reporter): ScreenDeclaration {
  for (const [name, { attribute }] of given) {
    const reason = NOT_IN_WORLD[name];
    if (reason) {
      reporter.error({
        code: 'surface-attribute',
        message: `\`${name}\` has no meaning on a world screen, which is drawn on a prop. ${reason}`,
        hint: `Remove \`${name}\`.`,
        start: attribute.start,
        end: attribute.end,
      });
    }
  }
  const size = readSize(text, invalid);
  if (!size) {
    reporter.error({
      code: 'world-size',
      message: 'A world screen needs a `size`: the resolution of the browser that draws it.',
      hint: 'Add it, for example `<screen surface="world" size="1280x720" />`.',
      start: tag.start,
      end: tag.end,
    });
  }
  return {
    focus: { mouse: false, keyboard: false },
    keepInput: false,
    close: 'none',
    size,
    layer: 'screen',
    cursor: text('cursor', 'a CSS cursor') ?? null,
    surface: 'world',
  };
}

const EXAMPLES: Record<string, string> = {
  focus: 'focus="mouse keyboard"',
  'keep-input': 'keep-input',
  close: 'close="escape"',
  size: 'size="1920x1080"',
  layer: 'layer="hud"',
  cursor: 'cursor="default"',
  surface: 'surface="phone"',
};
