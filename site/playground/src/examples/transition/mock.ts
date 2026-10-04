import { mock } from 'nexus/contract';
import contract from './contract';

const messages = [
  { kind: 'success', text: 'Vehicle stored in the garage.' },
  { kind: 'info', text: 'Lester sent you a message.' },
  { kind: 'warning', text: 'Fuel is running low.' },
] as const;

export default mock(contract, {
  // What the game does on its own account: here, a notification every few seconds.
  setup({ push, action }) {
    let sent = 0;
    const notify = (): void => {
      const message = messages[sent % messages.length];
      if (message) push('notify', { id: ++sent, ...message });
    };

    setTimeout(notify, 400);
    setInterval(notify, 2600);
    action('Notify now', notify);
  },
});
