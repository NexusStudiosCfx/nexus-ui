import { mock, reject } from 'nexus/contract';
import locale from '../locales/en.json';
import contract from './contract';

// The same catalogue as config.lua, and the same rules as server/main.lua, so that the page
// behaves in the browser as it does in game.
const catalogue = [
  { model: 'blista', label: 'Blista', class: 'compact', price: 8000, speed: 48, acceleration: 46, handling: 62 },
  { model: 'sanchez', label: 'Sanchez', class: 'motorcycle', price: 9500, speed: 54, acceleration: 66, handling: 70 },
  { model: 'baller', label: 'Baller', class: 'suv', price: 22000, speed: 58, acceleration: 50, handling: 48 },
  { model: 'sultan', label: 'Sultan', class: 'sports', price: 28000, speed: 68, acceleration: 70, handling: 72 },
  { model: 'bati', label: 'Bati 801', class: 'motorcycle', price: 31000, speed: 82, acceleration: 88, handling: 76 },
  { model: 'elegy2', label: 'Elegy RH8', class: 'sports', price: 46000, speed: 76, acceleration: 78, handling: 80 },
  { model: 'comet2', label: 'Comet', class: 'sports', price: 58000, speed: 80, acceleration: 82, handling: 74 },
  { model: 'banshee', label: 'Banshee', class: 'sports', price: 64000, speed: 84, acceleration: 80, handling: 70 },
  { model: 'zentorno', label: 'Zentorno', class: 'super', price: 185000, speed: 96, acceleration: 94, handling: 86 },
] as const;

let balance = 60000;
const owned = new Set<string>(['blista']);

const serverDelay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 350));

export default mock(contract, {
  locale,
  state: {
    hud: { visible: true, speed: 0, fuel: 64, engine: 97, street: 'Vinewood Boulevard' },
  },
  calls: {
    'garage:list': async () => {
      await serverDelay();
      return { balance, vehicles: catalogue.map((vehicle) => ({ ...vehicle, owned: owned.has(vehicle.model) })) };
    },
    'garage:buy': async ({ model }) => {
      await serverDelay();
      const vehicle = catalogue.find((item) => item.model === model);
      if (!vehicle) return reject('unknown_vehicle');
      if (owned.has(model)) return reject('already_owned');
      if (balance < vehicle.price) return reject('not_enough_money', { missing: vehicle.price - balance });
      balance -= vehicle.price;
      owned.add(model);
      return { balance };
    },
  },
  client: {
    'garage:preview': ({ model }) => console.info(`[mock] client Lua would show a preview of ${model}`),
  },
  setup({ open, set }) {
    open('hud');
    // A car that pulls away, cruises and brakes, so the HUD has something to show.
    let speed = 0;
    let fuel = 64;
    let tick = 0;
    setInterval(() => {
      tick++;
      const phase = tick % 240;
      speed = Math.max(0, Math.min(142, speed + (phase < 110 ? 1.6 : phase < 170 ? 0 : -2.6)));
      if (tick % 50 === 0) fuel = fuel > 4 ? fuel - 1 : 64;
      set('hud', { speed: Math.round(speed), fuel });
    }, 100);
  },
});
