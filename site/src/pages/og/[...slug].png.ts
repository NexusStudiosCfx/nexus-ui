/**
 * The social image of every page, drawn at build time: /og/index.png for the landing page,
 * /og/playground.png, and /og/<id>.png for each page of the docs.
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import satori from 'satori';
import sharp from 'sharp';
import bold from '@fontsource/inter/files/inter-latin-800-normal.woff?inline';
import medium from '@fontsource/inter/files/inter-latin-500-normal.woff?inline';
import symbol from '../../assets/brand/symbol.png?inline';
import { SITE } from '../../../site.config.mjs';

interface Card {
  kicker: string;
  title: string;
}

const bytes = (dataUri: string) => Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64');

const fonts = [
  { name: 'Inter', data: bytes(bold), weight: 800 as const, style: 'normal' as const },
  { name: 'Inter', data: bytes(medium), weight: 500 as const, style: 'normal' as const },
];

export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection('docs');
  const card = (slug: string, props: Card) => ({ params: { slug }, props });
  return [
    card('index', { kicker: 'Open source, MIT', title: 'A UI framework built for FiveM resources.' }),
    card('playground', { kicker: 'Playground', title: 'Edit a .nexus component and watch it run.' }),
    ...docs.map((entry) => card(entry.id, { kicker: 'Documentation', title: entry.data.title })),
  ];
};

type Node = { type: string; props: Record<string, unknown> };
const box = (style: Record<string, unknown>, children?: unknown): Node => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } });

function draw({ kicker, title }: Card): Node {
  const mark: Node = { type: 'img', props: { src: symbol, width: 55, height: 64 } };
  return box(
    {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: '64px 72px',
      background: '#09090b',
      backgroundImage: 'radial-gradient(900px 520px at 50% -10%, rgba(200, 255, 61, 0.22), rgba(9, 9, 11, 0))',
      color: '#f5f5f5',
      fontFamily: 'Inter',
    },
    [
      box({ alignItems: 'center', gap: 18 }, [mark, box({ fontSize: 34, fontWeight: 800, letterSpacing: -1 }, SITE.name)]),
      box({ flexDirection: 'column', gap: 22 }, [
        box({ color: '#c8ff3d', fontSize: 24, fontWeight: 500, letterSpacing: 3, textTransform: 'uppercase' }, kicker),
        box({ fontSize: title.length > 44 ? 62 : 74, fontWeight: 800, letterSpacing: -3, lineHeight: 1.05 }, title),
      ]),
      box({ alignItems: 'center', justifyContent: 'space-between', color: '#a1a1aa', fontSize: 26, fontWeight: 500 }, [
        box({ padding: '14px 22px', borderRadius: 14, border: '1px solid rgba(255, 255, 255, 0.14)', background: '#111113', color: '#f5f5f5' }, `$ ${SITE.install}`),
        box({}, SITE.repository.replace('https://', '')),
      ]),
    ],
  );
}

export const GET: APIRoute = async ({ props }) => {
  const svg = await satori(draw(props as Card) as never, { width: 1200, height: 630, fonts });
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
