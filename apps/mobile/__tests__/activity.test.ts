import { AppState } from 'react-native';
import { mobileActivity } from '../src/activity';

jest.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: jest.fn() }, Platform: { OS: 'android' } }));

it('Android drawer blur stops activity without AppState change and removes every subscription', () => {
  const listeners = new Map<string, () => void>();
  const remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
    listeners.set(type, handler as () => void); return { remove };
  });
  const activity = mobileActivity();
  const seen: boolean[] = [];
  const unsubscribe = activity.subscribeActivity((active) => seen.push(active));
  expect(activity.isActive()).toBe(true);
  listeners.get('blur')!();
  expect(AppState.currentState).toBe('active');
  expect(activity.isActive()).toBe(false);
  listeners.get('change')!();
  expect(activity.isActive()).toBe(false);
  listeners.get('focus')!();
  expect(activity.isActive()).toBe(true);
  expect(seen).toEqual([false, false, true]);
  unsubscribe(); expect(remove).toHaveBeenCalledTimes(3);
});
