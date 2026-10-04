import { nui, NuiError, signal, t, type NexusContract } from 'nexus';
import { money, type Vehicle } from './format';

type BuyErrors = NexusContract['calls']['garage:buy']['errors'];

/** The text for a purchase the server refused. The amount that is missing comes with the refusal. */
function refusal(error: unknown): string {
  if (!(error instanceof NuiError)) return t('error.other', String(error));
  if (error.code === 'not_enough_money') {
    const { missing } = error.details as BuyErrors['not_enough_money'];
    return t('garage.short', money(missing));
  }
  const known = ['already_owned', 'unknown_vehicle', 'rate_limited', 'timeout'].includes(error.code);
  return known ? t(`error.${error.code}`) : t('error.other', error.code);
}

/**
 * The catalogue and the balance, with the two calls that change them. The garage screen and
 * the phone app both start from this, so they cannot disagree about what a purchase does.
 * Call it in the script of a component: the push it listens to is dropped with the component.
 */
export function useGarage() {
  const vehicles = signal<Vehicle[]>([]);
  const balance = signal(0);
  const status = signal<'loading' | 'ready' | 'failed'>('loading');
  const failure = signal('');

  async function load(): Promise<void> {
    status.value = 'loading';
    try {
      const garage = await nui.call('garage:list');
      vehicles.value = garage.vehicles;
      balance.value = garage.balance;
      status.value = 'ready';
    } catch (error) {
      failure.value = error instanceof NuiError ? error.code : String(error);
      status.value = 'failed';
    }
  }

  /** Resolves with whether the vehicle was bought, and the text to show either way. */
  async function buy(vehicle: Vehicle): Promise<{ done: boolean; text: string }> {
    try {
      // Only the model is sent. The server looks up the price and decides.
      const result = await nui.call('garage:buy', { model: vehicle.model });
      balance.value = result.balance;
      vehicles.value = vehicles.value.map((item) => (item.model === vehicle.model ? { ...item, owned: true } : item));
      return { done: true, text: t('garage.bought', vehicle.label) };
    } catch (error) {
      return { done: false, text: refusal(error) };
    }
  }

  nui.on('garage:balance', (data) => (balance.value = data.balance));
  void load();

  return { vehicles, balance, status, failure, load, buy };
}
