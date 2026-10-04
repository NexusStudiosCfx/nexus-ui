const REPOSITORY = 'https://github.com/NexusStudiosCfx/nexus-ui';
const PACKAGE = '@nexusstudios/ui';
const INITIALIZER = 'create-nexus-ui';

/**
 * Where the site is served, the commands it tells people to run, and every address outside it.
 * Pages, the Astro config and the build scripts all read from here.
 */
export const SITE = {
  name: 'Nexus UI',
  description:
    'A UI framework for FiveM resources: .nexus components, a typed bridge to Lua, and screens that cost nothing while closed.',

  /**
   * The origin the site is served from, and the path under it: '' at the root of a domain,
   * '/nexus-ui' under a folder. SITE_ORIGIN and SITE_BASE set them for one build.
   */
  origin: process.env.SITE_ORIGIN ?? 'https://nexusstudios-ui.vercel.app',
  base: process.env.SITE_BASE ?? '',

  /**
   * The library on npm and the package behind `npm create`, then the command that starts a
   * resource and the one that adds the library to a resource that exists.
   */
  package: PACKAGE,
  initializer: INITIALIZER,
  install: 'npm create nexus-ui my_shop',
  add: `npm install --save-dev ${PACKAGE}`,

  repository: REPOSITORY,
  issues: `${REPOSITORY}/issues`,
  license: `${REPOSITORY}/blob/main/LICENSE`,
  example: `${REPOSITORY}/tree/main/examples/garage`,
  npm: `https://www.npmjs.com/package/${PACKAGE}`,
  npmInitializer: `https://www.npmjs.com/package/${INITIALIZER}`,
};
