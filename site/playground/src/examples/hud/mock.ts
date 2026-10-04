import { mock } from 'nexus/contract';
import contract from './contract';

export default mock(contract, {
  state: {
    hud: { speed: 0, fuel: 68, street: 'Vinewood Boulevard' },
  },
  // Plays the part of the client loop that calls Nexus.set('hud', ...) in game: a
  // car that pulls away, cruises and brakes. Only changed keys cross the bridge.
  setup({ set, action }) {
    let speed = 0;
    let fuel = 68;
    let tick = 0;

    setInterval(() => {
      const phase = tick++ % 120;
      const change = phase < 55 ? 3 : phase < 85 ? 0 : -5;
      speed = Math.max(0, Math.min(140, speed + change));
      if (tick % 15 === 0) fuel = Math.max(0, fuel - 1);
      set('hud', { speed, fuel });
    }, 100);

    // A button in the bar of the preview, for what only the game would trigger.
    action('Refuel', () => {
      fuel = 100;
      set('hud', { fuel });
    });
    action('Empty the tank', () => {
      fuel = 9;
      set('hud', { fuel });
    });
  },
});
