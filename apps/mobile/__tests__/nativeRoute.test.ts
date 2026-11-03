jest.mock('react-native', () => ({ NativeModules: { WorkhubNative: {} }, NativeEventEmitter: class {}, Platform: { OS: 'android' } }));
import { parseNativeRoute } from '../src/native';

describe('parseNativeRoute (incoming calls)', () => {
  it('accepts a call route with an optional accept/decline action', () => {
    expect(parseNativeRoute('{"tag":"t1","route":{"name":"call","token":"abc123"}}')).toEqual({ tag: 't1', route: { name: 'call', token: 'abc123' } });
    expect(parseNativeRoute('{"tag":"t1","route":{"name":"call","token":"abc123","action":"accept"}}')).toEqual({ tag: 't1', route: { name: 'call', token: 'abc123', action: 'accept' } });
  });
  it('drops unknown actions and invalid tokens', () => {
    expect(parseNativeRoute('{"tag":"t1","route":{"name":"call","token":"abc123","action":"rm -rf"}}')).toEqual({ tag: 't1', route: { name: 'call', token: 'abc123' } });
    expect(parseNativeRoute('{"tag":"t1","route":{"name":"call","token":"../x"}}')).toEqual({ tag: 't1', route: { name: 'inbox' } });
  });
});
